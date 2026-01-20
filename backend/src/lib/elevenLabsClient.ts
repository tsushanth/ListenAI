import axios, { AxiosInstance, AxiosError } from 'axios';
import { Readable } from 'stream';
import { ttsLogger } from './logger.js';
import { TTSProviderError } from '../types/index.js';

// ============================================================================
// ElevenLabs TTS Client
// ============================================================================

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

// Default model: eleven_turbo_v2_5 for low latency
// Alternative: eleven_multilingual_v2 for higher quality
const DEFAULT_MODEL = 'eleven_turbo_v2_5';

// Voice settings for natural speech
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  use_speaker_boost: true,
};

// Map of our voice IDs to ElevenLabs voice IDs
// ElevenLabs has pre-made voices and custom cloned voices
const VOICE_MAP: Record<string, string> = {
  // Default voices - map Kokoro IDs to ElevenLabs equivalents
  'am_adam': 'pNInz6obpgDQGcFmaJgB', // Adam - deep male voice
  'am_michael': 'flq6f7yk4E4fJM5XTYuZ', // Michael - American male
  'af_nicole': 'piTKgcLEGmPE4e6mEKli', // Nicole - American female
  'af_sarah': 'EXAVITQu4vr4xnSDxMaL', // Sarah - American female (default)
  'bf_emma': 'XB0fDUnXU5powFXDhCwa', // Emma - British female
  'bm_george': 'JBFqnCBsd6RMkjVDRZzb', // George - British male

  // ElevenLabs native IDs pass through
  // Add more mappings as needed
};

// Output format options for ElevenLabs
type OutputFormat =
  | 'mp3_44100_64'   // MP3 44.1kHz @ 64kbps (smallest)
  | 'mp3_44100_96'   // MP3 44.1kHz @ 96kbps
  | 'mp3_44100_128'  // MP3 44.1kHz @ 128kbps (default)
  | 'mp3_44100_192'  // MP3 44.1kHz @ 192kbps (highest quality MP3)
  | 'pcm_16000'      // PCM 16kHz
  | 'pcm_22050'      // PCM 22.05kHz
  | 'pcm_24000'      // PCM 24kHz
  | 'pcm_44100';     // PCM 44.1kHz

export interface ElevenLabsRequest {
  text: string;
  voiceId: string;
  modelId?: string;
  speed?: number;
  outputFormat?: OutputFormat;
  voiceSettings?: {
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
}

export interface ElevenLabsResponse {
  audioBuffer: Buffer;
  format: 'mp3' | 'pcm';
  characterCount: number;
  latencyMs?: number;
}

export interface ElevenLabsStreamChunk {
  audio: Buffer;           // Raw MP3 chunk
  isFinal: boolean;
  characterCount?: number;
  alignment?: {
    chars: string[];
    charStartTimesMs: number[];
    charDurationsMs: number[];
  };
}

/**
 * ElevenLabs TTS Client
 *
 * Key features:
 * - Returns MP3 directly (no conversion needed)
 * - Streaming support for micro-preview
 * - Low-latency turbo model
 */
export class ElevenLabsClient {
  private client: AxiosInstance;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;

    this.client = axios.create({
      baseURL: ELEVENLABS_BASE_URL,
      headers: {
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
      },
      timeout: 60000, // 60 second timeout
    });

    ttsLogger.info('ElevenLabs client initialized');
  }

  /**
   * Map internal voice ID to ElevenLabs voice ID.
   */
  private mapVoiceId(voiceId: string): string {
    // Check if it's already an ElevenLabs ID (long alphanumeric string)
    if (voiceId.length > 15 && /^[a-zA-Z0-9]+$/.test(voiceId)) {
      return voiceId;
    }

    // Map from our voice ID to ElevenLabs ID
    const mappedId = VOICE_MAP[voiceId];
    if (mappedId) {
      return mappedId;
    }

    // Default to Sarah (clear female voice) if no mapping found
    ttsLogger.warn({ voiceId }, 'No ElevenLabs mapping for voice, using default Sarah');
    return 'EXAVITQu4vr4xnSDxMaL'; // Sarah
  }

  /**
   * Synthesize text to speech (non-streaming).
   * Returns MP3 audio directly - no conversion needed.
   */
  async synthesize(request: ElevenLabsRequest): Promise<ElevenLabsResponse> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;
    const outputFormat = request.outputFormat ?? 'mp3_44100_128';

    ttsLogger.info({
      voiceId,
      originalVoiceId: request.voiceId,
      modelId,
      textLength: request.text.length,
      outputFormat,
    }, 'ElevenLabs: starting synthesis');

    const startTime = Date.now();

    try {
      const response = await this.client.post(
        `/text-to-speech/${voiceId}`,
        {
          text: request.text,
          model_id: modelId,
          voice_settings: {
            ...DEFAULT_VOICE_SETTINGS,
            ...request.voiceSettings,
          },
        },
        {
          params: {
            output_format: outputFormat,
            optimize_streaming_latency: 3, // Optimize for low latency
          },
          responseType: 'arraybuffer',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
        }
      );

      const latencyMs = Date.now() - startTime;
      const audioBuffer = Buffer.from(response.data);

      // Get character count from header if available
      const characterCount = response.headers['character-count']
        ? parseInt(response.headers['character-count'], 10)
        : request.text.length;

      ttsLogger.info({
        latencyMs,
        audioSize: audioBuffer.length,
        characterCount,
      }, 'ElevenLabs: synthesis complete');

      return {
        audioBuffer,
        format: 'mp3',
        characterCount,
        latencyMs,
      };
    } catch (error) {
      ttsLogger.error({ error, voiceId, textLength: request.text.length }, 'ElevenLabs synthesis failed');
      throw this.handleError(error);
    }
  }

  /**
   * Stream text to speech for micro-preview.
   * Yields MP3 chunks as they're generated.
   *
   * This is the key for immediate playback - we can start playing
   * the first chunk while the rest is still being generated.
   */
  async *synthesizeStream(request: ElevenLabsRequest): AsyncGenerator<ElevenLabsStreamChunk> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;
    const outputFormat = request.outputFormat ?? 'mp3_44100_64'; // Use lower bitrate for streaming

    ttsLogger.info({
      voiceId,
      modelId,
      textLength: request.text.length,
    }, 'ElevenLabs: starting streaming synthesis');

    try {
      const response = await this.client.post(
        `/text-to-speech/${voiceId}/stream`,
        {
          text: request.text,
          model_id: modelId,
          voice_settings: {
            ...DEFAULT_VOICE_SETTINGS,
            ...request.voiceSettings,
          },
        },
        {
          params: {
            output_format: outputFormat,
            optimize_streaming_latency: 4, // Maximum latency optimization for streaming
          },
          responseType: 'stream',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
        }
      );

      const stream = response.data as Readable;
      let chunkIndex = 0;
      let totalBytes = 0;

      for await (const chunk of stream) {
        const audioChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += audioChunk.length;
        chunkIndex++;

        ttsLogger.debug({
          chunkIndex,
          chunkSize: audioChunk.length,
          totalBytes,
        }, 'ElevenLabs: received stream chunk');

        yield {
          audio: audioChunk,
          isFinal: false,
        };
      }

      // Yield final marker
      yield {
        audio: Buffer.alloc(0),
        isFinal: true,
        characterCount: request.text.length,
      };

      ttsLogger.info({
        totalChunks: chunkIndex,
        totalBytes,
      }, 'ElevenLabs: streaming synthesis complete');
    } catch (error) {
      ttsLogger.error({ error, voiceId }, 'ElevenLabs streaming failed');
      throw this.handleError(error);
    }
  }

  /**
   * Generate micro-preview audio (first ~3-5 seconds).
   * Uses streaming to get audio ASAP, then returns accumulated buffer.
   *
   * targetDurationMs: How much audio to accumulate before returning
   */
  async synthesizeMicroPreview(
    request: ElevenLabsRequest,
    targetDurationMs: number = 3000
  ): Promise<{ audio: Buffer; isComplete: boolean }> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;

    // Use lower bitrate for micro-preview (faster)
    const outputFormat = 'mp3_44100_64';

    // Estimate bytes needed for target duration
    // 64kbps = 8KB/sec, so 3 seconds ≈ 24KB
    const targetBytes = Math.ceil((targetDurationMs / 1000) * 8000);

    ttsLogger.info({
      voiceId,
      modelId,
      textLength: request.text.length,
      targetDurationMs,
      targetBytes,
    }, 'ElevenLabs: starting micro-preview synthesis');

    const startTime = Date.now();

    try {
      const response = await this.client.post(
        `/text-to-speech/${voiceId}/stream`,
        {
          text: request.text,
          model_id: modelId,
          voice_settings: {
            ...DEFAULT_VOICE_SETTINGS,
            ...request.voiceSettings,
          },
        },
        {
          params: {
            output_format: outputFormat,
            optimize_streaming_latency: 4, // Maximum latency optimization
          },
          responseType: 'stream',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
        }
      );

      const stream = response.data as Readable;
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let isComplete = true;

      for await (const chunk of stream) {
        const audioChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(audioChunk);
        totalBytes += audioChunk.length;

        // Once we have enough audio for micro-preview, we can stop
        // but we'll keep reading to avoid connection issues
        if (totalBytes >= targetBytes && chunks.length > 0) {
          // For micro-preview, we want to return ASAP
          // We'll let the full audio generation continue in the background
          const latencyMs = Date.now() - startTime;

          ttsLogger.info({
            latencyMs,
            audioSize: totalBytes,
            chunks: chunks.length,
          }, 'ElevenLabs: micro-preview ready');
        }
      }

      const audioBuffer = Buffer.concat(chunks);
      const latencyMs = Date.now() - startTime;

      ttsLogger.info({
        latencyMs,
        audioSize: audioBuffer.length,
        isComplete,
      }, 'ElevenLabs: micro-preview complete');

      return {
        audio: audioBuffer,
        isComplete,
      };
    } catch (error) {
      ttsLogger.error({ error, voiceId }, 'ElevenLabs micro-preview failed');
      throw this.handleError(error);
    }
  }

  /**
   * Get available voices from ElevenLabs.
   */
  async getVoices(): Promise<Array<{ voice_id: string; name: string; category: string }>> {
    try {
      const response = await this.client.get('/voices');
      return response.data.voices;
    } catch (error) {
      ttsLogger.error({ error }, 'Failed to get ElevenLabs voices');
      throw this.handleError(error);
    }
  }

  /**
   * Get user subscription info (for quota tracking).
   */
  async getSubscriptionInfo(): Promise<{
    character_count: number;
    character_limit: number;
    can_extend_character_limit: boolean;
    next_character_count_reset_unix: number;
  }> {
    try {
      const response = await this.client.get('/user/subscription');
      return response.data;
    } catch (error) {
      ttsLogger.error({ error }, 'Failed to get ElevenLabs subscription info');
      throw this.handleError(error);
    }
  }

  private handleError(error: unknown): TTSProviderError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{ detail?: { message?: string; status?: string } }>;

      const status = axiosError.response?.status;
      const detail = axiosError.response?.data?.detail;

      // Handle specific ElevenLabs errors
      if (status === 401) {
        return new TTSProviderError('ElevenLabs', 'Invalid API key');
      }
      if (status === 422) {
        const message = detail?.message ?? 'Invalid request parameters';
        return new TTSProviderError('ElevenLabs', message);
      }
      if (status === 429) {
        return new TTSProviderError('ElevenLabs', 'Rate limit exceeded - please try again later');
      }
      if (status === 500 || status === 502 || status === 503) {
        return new TTSProviderError('ElevenLabs', 'ElevenLabs service temporarily unavailable');
      }

      // Network errors
      if (axiosError.code === 'ECONNRESET' || axiosError.code === 'ETIMEDOUT') {
        return new TTSProviderError('ElevenLabs', 'Connection to ElevenLabs failed - please try again');
      }

      return new TTSProviderError('ElevenLabs', axiosError.message);
    }

    return new TTSProviderError('ElevenLabs', 'Unknown error');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let elevenLabsClient: ElevenLabsClient | null = null;

export function getElevenLabsClient(): ElevenLabsClient | null {
  if (elevenLabsClient) {
    return elevenLabsClient;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    ttsLogger.warn('ELEVENLABS_API_KEY not configured - ElevenLabs TTS unavailable');
    return null;
  }

  elevenLabsClient = new ElevenLabsClient(apiKey);
  return elevenLabsClient;
}

export function isElevenLabsConfigured(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}
