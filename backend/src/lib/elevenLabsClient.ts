import axios, { AxiosInstance, AxiosError } from 'axios';
import * as http from 'http';
import * as https from 'https';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { ttsLogger } from './logger.js';
import { TTSProviderError } from '../types/index.js';
import type { TTSProviderRequest, TTSProviderResponse } from '../types/index.js';

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

// ============================================================================
// HTTP Agent with Keep-Alive for Connection Reuse
// ============================================================================

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,       // Keep connections alive for 30s
  maxSockets: 10,              // Max concurrent connections
  maxFreeSockets: 5,           // Max idle connections to keep
  timeout: 120000,             // Socket timeout 2 minutes
  rejectUnauthorized: true,    // Verify SSL certificates
});

// ============================================================================
// Retry Configuration
// ============================================================================

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
  retryableCodes: string[];
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableStatuses: [429, 500, 502, 503, 504],
  retryableCodes: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'],
};

function isRetryableError(error: unknown, config: RetryConfig): boolean {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    if (axiosError.code && config.retryableCodes.includes(axiosError.code)) {
      return true;
    }
    const status = axiosError.response?.status;
    if (status && config.retryableStatuses.includes(status)) {
      return true;
    }
  }
  return false;
}

function calculateBackoffDelay(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(config.maxDelayMs, exponentialDelay + jitter);
}

// ============================================================================
// TTFB Timing Interface
// ============================================================================

export interface TTFBMetrics {
  t_start: number;           // Timestamp when request started
  t_first_byte: number;      // Timestamp when first byte received
  t_done: number;            // Timestamp when transfer complete
  ttfb_ms: number;           // Time to first byte in ms
  total_ms: number;          // Total time in ms
  bytes_received: number;    // Total bytes received
}

// ============================================================================
// Request/Response Types
// ============================================================================

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
  metrics: TTFBMetrics;
}

export interface ElevenLabsStreamChunk {
  audio: Buffer;           // Raw MP3 chunk
  isFinal: boolean;
  characterCount?: number;
  metrics?: TTFBMetrics;   // Only on final chunk
}

export interface StreamToFileResult {
  filePath: string;
  bytesWritten: number;
  metrics: TTFBMetrics;
}

// ============================================================================
// Provider Interface (for ttsProviderClient.ts integration)
// ============================================================================

export interface TTSProviderInterface {
  synthesize(request: TTSProviderRequest): Promise<TTSProviderResponse>;
  synthesizeToStream(request: TTSProviderRequest, output: Writable): Promise<TTFBMetrics>;
  synthesizeToFile(request: TTSProviderRequest, filePath: string): Promise<StreamToFileResult>;
  isAvailable(): boolean;
  getName(): string;
}

// ============================================================================
// ElevenLabs TTS Client
// ============================================================================

/**
 * ElevenLabs TTS Client
 *
 * Key features:
 * - Returns MP3 directly (no conversion needed)
 * - Streaming support for micro-preview and direct file writing
 * - HTTP keep-alive for connection reuse
 * - Retry with exponential backoff for transient failures
 * - TTFB metrics logging
 */
export class ElevenLabsClient implements TTSProviderInterface {
  private client: AxiosInstance;
  private apiKey: string;
  private retryConfig: RetryConfig;

  constructor(apiKey: string, retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG) {
    this.apiKey = apiKey;
    this.retryConfig = retryConfig;

    this.client = axios.create({
      baseURL: ELEVENLABS_BASE_URL,
      headers: {
        'xi-api-key': apiKey,
        'Accept': 'audio/mpeg',
      },
      timeout: 120000, // 2 minute timeout
      httpsAgent: httpsAgent,
    });

    ttsLogger.info('ElevenLabs client initialized with keep-alive and retry support');
  }

  getName(): string {
    return 'elevenlabs';
  }

  isAvailable(): boolean {
    return !!this.apiKey;
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
   * Synthesize text to speech with retry support.
   * Returns MP3 audio directly - no conversion needed.
   * Implements TTSProviderInterface.
   */
  async synthesize(request: TTSProviderRequest): Promise<TTSProviderResponse> {
    const result = await this.synthesizeInternal({
      text: request.text,
      voiceId: request.voiceId,
      modelId: request.modelId,
      speed: request.speed,
    });

    return {
      audioBuffer: result.audioBuffer,
      format: 'mp3',
      durationMs: undefined, // ElevenLabs doesn't return duration directly
    };
  }

  /**
   * Internal synthesize with full metrics.
   */
  async synthesizeInternal(request: ElevenLabsRequest): Promise<ElevenLabsResponse> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;
    const outputFormat = request.outputFormat ?? 'mp3_44100_128';

    const t_start = Date.now();

    ttsLogger.info({
      voiceId,
      originalVoiceId: request.voiceId,
      modelId,
      textLength: request.text.length,
      outputFormat,
      t_start,
    }, 'ElevenLabs: starting synthesis');

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
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
              optimize_streaming_latency: 3,
            },
            responseType: 'arraybuffer',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg',
            },
          }
        );

        const t_done = Date.now();
        const audioBuffer = Buffer.from(response.data);

        // For non-streaming, t_first_byte ≈ t_done (we get it all at once)
        const metrics: TTFBMetrics = {
          t_start,
          t_first_byte: t_done, // Can't measure TTFB with arraybuffer response
          t_done,
          ttfb_ms: t_done - t_start,
          total_ms: t_done - t_start,
          bytes_received: audioBuffer.length,
        };

        const characterCount = response.headers['character-count']
          ? parseInt(response.headers['character-count'], 10)
          : request.text.length;

        ttsLogger.info({
          ...metrics,
          characterCount,
          audioSize: audioBuffer.length,
          attempt: attempt + 1,
        }, 'ElevenLabs: synthesis complete');

        return {
          audioBuffer,
          format: 'mp3',
          characterCount,
          metrics,
        };
      } catch (error) {
        lastError = error;

        if (!isRetryableError(error, this.retryConfig) || attempt >= this.retryConfig.maxRetries) {
          ttsLogger.error({
            error,
            voiceId,
            textLength: request.text.length,
            attempt: attempt + 1,
          }, 'ElevenLabs synthesis failed');
          throw this.handleError(error);
        }

        const delay = calculateBackoffDelay(attempt, this.retryConfig);
        ttsLogger.warn({
          error: axios.isAxiosError(error) ? error.code : 'unknown',
          attempt: attempt + 1,
          delayMs: delay,
        }, 'ElevenLabs: retrying after transient failure');

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw this.handleError(lastError);
  }

  /**
   * Stream synthesis directly to a Writable stream (pipe).
   * Does NOT buffer entire audio in memory.
   * Returns TTFB metrics.
   */
  async synthesizeToStream(request: TTSProviderRequest, output: Writable): Promise<TTFBMetrics> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;
    const outputFormat = 'mp3_44100_128';

    const t_start = Date.now();
    let t_first_byte = 0;
    let bytesReceived = 0;

    ttsLogger.info({
      voiceId,
      originalVoiceId: request.voiceId,
      modelId,
      textLength: request.text.length,
      t_start,
    }, 'ElevenLabs: starting stream-to-pipe synthesis');

    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        const response = await this.client.post(
          `/text-to-speech/${voiceId}/stream`,
          {
            text: request.text,
            model_id: modelId,
            voice_settings: DEFAULT_VOICE_SETTINGS,
          },
          {
            params: {
              output_format: outputFormat,
              optimize_streaming_latency: 4,
            },
            responseType: 'stream',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg',
            },
          }
        );

        const stream = response.data as Readable;

        // Track first byte timing
        stream.once('data', () => {
          t_first_byte = Date.now();
          ttsLogger.info({
            t_start,
            t_first_byte,
            ttfb_ms: t_first_byte - t_start,
          }, 'ElevenLabs: received first byte');
        });

        // Track bytes received
        stream.on('data', (chunk: Buffer) => {
          bytesReceived += chunk.length;
        });

        // Pipe stream to output
        await pipeline(stream, output);

        const t_done = Date.now();

        const metrics: TTFBMetrics = {
          t_start,
          t_first_byte: t_first_byte || t_done,
          t_done,
          ttfb_ms: (t_first_byte || t_done) - t_start,
          total_ms: t_done - t_start,
          bytes_received: bytesReceived,
        };

        ttsLogger.info({
          ...metrics,
          attempt: attempt + 1,
        }, 'ElevenLabs: stream-to-pipe complete');

        return metrics;
      } catch (error) {
        lastError = error;

        if (!isRetryableError(error, this.retryConfig) || attempt >= this.retryConfig.maxRetries) {
          ttsLogger.error({
            error,
            voiceId,
            attempt: attempt + 1,
          }, 'ElevenLabs stream-to-pipe failed');
          throw this.handleError(error);
        }

        const delay = calculateBackoffDelay(attempt, this.retryConfig);
        ttsLogger.warn({
          error: axios.isAxiosError(error) ? error.code : 'unknown',
          attempt: attempt + 1,
          delayMs: delay,
        }, 'ElevenLabs: retrying stream after transient failure');

        await new Promise(resolve => setTimeout(resolve, delay));

        // Reset counters for retry
        t_first_byte = 0;
        bytesReceived = 0;
      }
    }

    throw this.handleError(lastError);
  }

  /**
   * Stream synthesis directly to a file.
   * Does NOT buffer entire audio in memory.
   * Returns file path and TTFB metrics.
   */
  async synthesizeToFile(request: TTSProviderRequest, filePath: string): Promise<StreamToFileResult> {
    const fileStream = createWriteStream(filePath);

    try {
      const metrics = await this.synthesizeToStream(request, fileStream);

      return {
        filePath,
        bytesWritten: metrics.bytes_received,
        metrics,
      };
    } catch (error) {
      // Clean up partial file on error
      fileStream.destroy();
      throw error;
    }
  }

  /**
   * Stream text to speech for micro-preview with TTFB tracking.
   * Yields MP3 chunks as they're generated.
   */
  async *synthesizeStream(request: ElevenLabsRequest): AsyncGenerator<ElevenLabsStreamChunk> {
    const voiceId = this.mapVoiceId(request.voiceId);
    const modelId = request.modelId ?? DEFAULT_MODEL;
    const outputFormat = request.outputFormat ?? 'mp3_44100_64';

    const t_start = Date.now();
    let t_first_byte = 0;
    let totalBytes = 0;

    ttsLogger.info({
      voiceId,
      modelId,
      textLength: request.text.length,
      t_start,
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
            optimize_streaming_latency: 4,
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

      for await (const chunk of stream) {
        const audioChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        // Track first byte
        if (t_first_byte === 0) {
          t_first_byte = Date.now();
          ttsLogger.info({
            t_start,
            t_first_byte,
            ttfb_ms: t_first_byte - t_start,
          }, 'ElevenLabs: received first byte (streaming)');
        }

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

      const t_done = Date.now();

      const metrics: TTFBMetrics = {
        t_start,
        t_first_byte: t_first_byte || t_done,
        t_done,
        ttfb_ms: (t_first_byte || t_done) - t_start,
        total_ms: t_done - t_start,
        bytes_received: totalBytes,
      };

      // Yield final chunk with metrics
      yield {
        audio: Buffer.alloc(0),
        isFinal: true,
        characterCount: request.text.length,
        metrics,
      };

      ttsLogger.info({
        ...metrics,
        totalChunks: chunkIndex,
      }, 'ElevenLabs: streaming synthesis complete');
    } catch (error) {
      ttsLogger.error({ error, voiceId }, 'ElevenLabs streaming failed');
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

// Export voice map for external use
export { VOICE_MAP };
