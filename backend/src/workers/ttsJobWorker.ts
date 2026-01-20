import { spawn } from 'child_process';
import { Readable } from 'stream';
import { logger } from '../lib/logger.js';
import {
  supabase,
  updateTTSJobProgress,
  upsertCacheEntry,
  uploadAudioToCache,
} from '../lib/supabaseClient.js';
import { ttsProvider } from '../lib/ttsProviderClient.js';
import {
  getElevenLabsClient,
  isElevenLabsConfigured,
  type ElevenLabsRequest,
  type TTFBMetrics,
} from '../lib/elevenLabsClient.js';
import { generateAudioPath } from '../lib/cacheKey.js';
import {
  startSubscription,
  republishForRetry,
  type TTSJobMessage,
} from '../lib/pubsub.js';
import {
  initJobMetrics,
  recordProcessingStart,
  recordSegmentInference,
  recordPartialReady,
  recordJobReady,
  recordJobFailure,
  trackJobResult,
  recordInferenceLatency,
  startMetricsReporting,
  stopMetricsReporting,
} from '../lib/metrics.js';
import type { AudioFormat, DBVoice, TTSProvider } from '../types/index.js';

// ============================================================================
// TTS Job Worker (Pub/Sub-based) with Preview-First Support
// ============================================================================

const workerLogger = logger.child({ module: 'tts-worker' });

// Configuration
const PREVIEW_TARGET_DURATION_SEC = 15;  // Target ~15 seconds for preview
const PREVIEW_MIN_CHARS = 200;           // Minimum characters for preview
const PREVIEW_MAX_CHARS = 2000;          // Maximum characters for preview
const SHORT_TEXT_THRESHOLD = 500;        // Below this, skip preview (just generate full)

// Micro-preview configuration (for instant playback)
const MICRO_TARGET_CHARS = 200;          // Target ~200 characters for micro-preview (~2-3 seconds)
const MICRO_MIN_CHARS = 50;              // Minimum chars for micro (at least something to play)
const MICRO_MAX_SENTENCES = 2;           // Max 1-2 sentences for micro

/**
 * Get the configured TTS provider.
 * Priority:
 * 1. TTS_PROVIDER env var (explicit override)
 * 2. If ELEVENLABS_API_KEY is set, use elevenlabs
 * 3. Otherwise, use selfhosted
 */
function getConfiguredProvider(): TTSProvider {
  const explicitProvider = process.env.TTS_PROVIDER as TTSProvider | undefined;

  if (explicitProvider) {
    workerLogger.info({ provider: explicitProvider }, 'Using explicitly configured TTS provider');
    return explicitProvider;
  }

  if (isElevenLabsConfigured()) {
    workerLogger.info({ provider: 'elevenlabs' }, 'Using ElevenLabs (ELEVENLABS_API_KEY configured)');
    return 'elevenlabs';
  }

  workerLogger.info({ provider: 'selfhosted' }, 'Using self-hosted TTS (fallback)');
  return 'selfhosted';
}

/**
 * Log TTFB metrics for monitoring.
 */
function logTTFBMetrics(jobId: string, metrics: TTFBMetrics, provider: string): void {
  workerLogger.info({
    jobId,
    provider,
    t_start: metrics.t_start,
    t_first_byte: metrics.t_first_byte,
    t_done: metrics.t_done,
    ttfb_ms: metrics.ttfb_ms,
    total_ms: metrics.total_ms,
    bytes_received: metrics.bytes_received,
  }, 'TTS synthesis TTFB metrics');
}

/**
 * Worker configuration
 */
interface WorkerConfig {
  maxRetries: number;
  enabled: boolean;
  stuckJobTimeoutMs: number;
}

const DEFAULT_CONFIG: WorkerConfig = {
  maxRetries: 3,
  enabled: true,
  stuckJobTimeoutMs: 3 * 60 * 1000,  // 3 minutes
};

let workerConfig = { ...DEFAULT_CONFIG };
let isRunning = false;
let stopSubscription: (() => void) | null = null;
let stuckJobInterval: NodeJS.Timeout | null = null;

// Worker instance identifier for metrics
const WORKER_INSTANCE = process.env.K_REVISION || `worker-${Date.now()}`;

// ============================================================================
// Text Segmentation
// ============================================================================

/**
 * Split text into sentences for chunked processing.
 * Returns array of sentences.
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end
  const sentencePattern = /[.!?]+[\s]+|[.!?]+$/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match;

  while ((match = sentencePattern.exec(text)) !== null) {
    const sentence = text.slice(lastIndex, match.index + match[0].length).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    lastIndex = match.index + match[0].length;
  }

  // Add any remaining text
  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    sentences.push(remaining);
  }

  return sentences;
}

/**
 * Estimate character count for target duration.
 * Average speaking rate is ~150 words/min = ~750 chars/min = ~12.5 chars/sec
 * Kokoro tends to be slightly faster, so we use ~15 chars/sec
 */
function estimateCharsForDuration(durationSec: number, speed: number = 1.0): number {
  const charsPerSecond = 15 * speed;
  return Math.round(durationSec * charsPerSecond);
}

/**
 * Select sentences for preview (first ~15 seconds worth).
 */
function selectPreviewSentences(sentences: string[], speed: number = 1.0): {
  previewSentences: string[];
  remainingSentences: string[];
} {
  const targetChars = estimateCharsForDuration(PREVIEW_TARGET_DURATION_SEC, speed);
  const previewSentences: string[] = [];
  let charCount = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;  // Non-null assertion - we're iterating within bounds

    // Always include at least one sentence
    if (previewSentences.length === 0) {
      previewSentences.push(sentence);
      charCount += sentence.length;
      continue;
    }

    // Check if adding this sentence would exceed target
    if (charCount + sentence.length > targetChars && charCount >= PREVIEW_MIN_CHARS) {
      // We have enough for preview
      return {
        previewSentences,
        remainingSentences: sentences.slice(i),
      };
    }

    // Check if we've hit max preview chars
    if (charCount >= PREVIEW_MAX_CHARS) {
      return {
        previewSentences,
        remainingSentences: sentences.slice(i),
      };
    }

    previewSentences.push(sentence);
    charCount += sentence.length;
  }

  // All sentences fit in preview
  return {
    previewSentences,
    remainingSentences: [],
  };
}

/**
 * Extract micro-preview text (first 1-2 sentences or ~200 chars).
 * This is the smallest playable chunk to minimize time-to-first-audio.
 *
 * Rules:
 * - Target ~200 characters (roughly 2-3 seconds of audio)
 * - At most 2 sentences
 * - Must end at a sentence boundary if possible
 * - At minimum 50 characters (to have something meaningful)
 */
function extractMicroText(text: string): { microText: string; remainingText: string } {
  // Clean the text first
  const cleanText = text.trim();

  if (cleanText.length <= MICRO_TARGET_CHARS) {
    // Text is small enough to be the entire micro
    return { microText: cleanText, remainingText: '' };
  }

  // Split into sentences
  const sentences = splitIntoSentences(cleanText);

  if (sentences.length === 0) {
    // Fallback: just take first 200 chars
    return {
      microText: cleanText.slice(0, MICRO_TARGET_CHARS),
      remainingText: cleanText.slice(MICRO_TARGET_CHARS),
    };
  }

  // Try to get 1-2 complete sentences up to target chars
  let microText = '';
  let sentenceCount = 0;

  for (const sentence of sentences) {
    // Check if adding this sentence would exceed limits
    const wouldExceedChars = (microText + ' ' + sentence).trim().length > MICRO_TARGET_CHARS;
    const wouldExceedSentences = sentenceCount >= MICRO_MAX_SENTENCES;

    // Always include at least one sentence
    if (sentenceCount === 0) {
      microText = sentence;
      sentenceCount++;
      continue;
    }

    // Stop if we've hit limits
    if (wouldExceedChars || wouldExceedSentences) {
      break;
    }

    // Add this sentence
    microText = microText + ' ' + sentence;
    sentenceCount++;
  }

  // Get remaining text
  const microLength = microText.length;
  const remainingText = cleanText.slice(microLength).trim();

  workerLogger.debug({
    totalLength: cleanText.length,
    microLength: microText.length,
    microSentences: sentenceCount,
    remainingLength: remainingText.length,
  }, 'Extracted micro-preview text');

  return { microText: microText.trim(), remainingText };
}

/**
 * Check if micro-preview already exists for a job (idempotency).
 */
async function microPreviewExists(jobId: string): Promise<boolean> {
  const { data: job } = await supabase
    .from('tts_jobs')
    .select('preview_audio_path, status')
    .eq('id', jobId)
    .single();

  if (!job) return false;

  // If job already has a preview path and is partial_ready or ready, micro exists
  if (job.preview_audio_path && (job.status === 'partial_ready' || job.status === 'ready')) {
    return true;
  }

  return false;
}

// ============================================================================
// Audio Processing
// ============================================================================

/**
 * Convert WAV buffer to MP3 using ffmpeg.
 */
async function convertWavToMp3(wavBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let stderrOutput = '';

    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 'mp3',
      '-b:a', '64k',
      '-ac', '1',
      '-ar', '24000',
      'pipe:1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
      workerLogger.debug({ ffmpeg: data.toString() }, 'ffmpeg output');
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        workerLogger.error({ code, stderr: stderrOutput.slice(-500) }, 'ffmpeg conversion failed');
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput.slice(-200)}`));
      }
    });

    ffmpeg.on('error', (err) => {
      workerLogger.error({ error: err.message }, 'ffmpeg spawn error');
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });

    // Handle stdin errors (EPIPE)
    ffmpeg.stdin.on('error', (err) => {
      workerLogger.error({ error: err.message, code: (err as NodeJS.ErrnoException).code }, 'ffmpeg stdin error');
      // Don't reject here - ffmpeg may have already closed due to an error
    });

    const inputStream = Readable.from(wavBuffer);
    inputStream.pipe(ffmpeg.stdin);
  });
}

/**
 * Concatenate multiple WAV buffers into one.
 */
async function concatenateWavBuffers(wavBuffers: Buffer[]): Promise<Buffer> {
  if (wavBuffers.length === 0) {
    throw new Error('No WAV buffers to concatenate');
  }
  if (wavBuffers.length === 1) {
    return wavBuffers[0]!;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    // Use ffmpeg to concatenate WAV files
    // We'll write each buffer as a separate input
    const inputArgs: string[] = [];
    for (let i = 0; i < wavBuffers.length; i++) {
      inputArgs.push('-i', `pipe:${i}`);
    }

    // Build filter complex for concatenation
    const filterInputs = wavBuffers.map((_, i) => `[${i}:a]`).join('');
    const filterComplex = `${filterInputs}concat=n=${wavBuffers.length}:v=0:a=1[out]`;

    const ffmpeg = spawn('ffmpeg', [
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-f', 'wav',
      '-acodec', 'pcm_s16le',
      '-ar', '24000',
      '-ac', '1',
      'pipe:',
    ], {
      stdio: ['pipe', 'pipe', 'pipe', ...wavBuffers.slice(1).map(() => 'pipe' as const)],
    });

    ffmpeg.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    ffmpeg.stderr.on('data', (data: Buffer) => {
      workerLogger.debug({ ffmpeg: data.toString() }, 'ffmpeg concat output');
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg concat exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg concat spawn error: ${err.message}`));
    });

    // Write all buffers to their respective pipes
    wavBuffers.forEach((buffer, i) => {
      const pipe = i === 0 ? ffmpeg.stdin : (ffmpeg.stdio[i + 3] as NodeJS.WritableStream);
      if (pipe) {
        const stream = Readable.from(buffer);
        stream.pipe(pipe);
      }
    });
  });
}

/**
 * Simple WAV concatenation by combining raw audio data.
 * Assumes all WAV files have the same format (24kHz, 16-bit, mono).
 */
function simpleWavConcat(wavBuffers: Buffer[]): Buffer {
  if (wavBuffers.length === 0) {
    throw new Error('No WAV buffers to concatenate');
  }
  if (wavBuffers.length === 1) {
    return wavBuffers[0]!;
  }

  // WAV header is 44 bytes
  const WAV_HEADER_SIZE = 44;

  // Extract raw audio data from each buffer (skip header)
  const audioDataChunks: Buffer[] = [];
  let totalDataSize = 0;

  for (const wav of wavBuffers) {
    if (wav.length <= WAV_HEADER_SIZE) {
      continue;  // Skip empty/invalid WAV
    }
    const audioData = wav.subarray(WAV_HEADER_SIZE);
    audioDataChunks.push(audioData);
    totalDataSize += audioData.length;
  }

  if (audioDataChunks.length === 0) {
    throw new Error('No valid audio data to concatenate');
  }

  // Create new WAV with combined data
  // Use the first WAV's header as template
  const header = Buffer.from(wavBuffers[0]!.subarray(0, WAV_HEADER_SIZE));

  // Update sizes in header
  // Bytes 4-7: ChunkSize = 36 + SubChunk2Size
  // Bytes 40-43: SubChunk2Size = totalDataSize
  header.writeUInt32LE(36 + totalDataSize, 4);
  header.writeUInt32LE(totalDataSize, 40);

  // Combine header with all audio data
  return Buffer.concat([header, ...audioDataChunks]);
}

/**
 * Get audio duration from MP3 buffer.
 *
 * V1 Strategy: Use estimation based on file size to avoid ffprobe EPIPE issues.
 * ElevenLabs returns MP3 at ~128kbps (16KB per second), so estimation is reliable.
 *
 * Accuracy: Within ±5% for typical TTS audio (consistent bitrate).
 */
async function getAudioDuration(audioBuffer: Buffer): Promise<number> {
  // ElevenLabs uses 128kbps MP3 encoding
  // 128 kbps = 128,000 bits/sec = 16,000 bytes/sec
  const BYTES_PER_SECOND = 16000;

  // Estimate duration from file size
  const estimatedDuration = Math.round(audioBuffer.length / BYTES_PER_SECOND);

  workerLogger.debug({
    bufferSize: audioBuffer.length,
    estimatedDuration,
  }, 'Audio duration estimated from file size');

  return estimatedDuration;
}

// ============================================================================
// ElevenLabs Synthesis (V1 Production) - Micro-First Strategy
// ============================================================================

/**
 * Generate micro-preview audio (first 1-2 sentences).
 * This is a separate, fast request to minimize time-to-first-audio.
 *
 * Strategy:
 * 1. Extract micro-text (first ~200 chars / 1-2 sentences)
 * 2. Generate micro.mp3 via ElevenLabs (fast, small request)
 * 3. Upload to Supabase Storage: tts/{jobId}/micro.mp3
 * 4. Update DB status to partial_ready with preview_url
 * 5. Return micro buffer and remaining text for full synthesis
 */
async function generateMicroPreview(
  jobId: string,
  text: string,
  voiceId: string
): Promise<{ microBuffer: Buffer; microPath: string; microDurationSec: number; remainingText: string } | null> {
  const elevenLabs = getElevenLabsClient();
  if (!elevenLabs) {
    throw new Error('ElevenLabs not configured');
  }

  // Check idempotency - skip if micro already exists
  const exists = await microPreviewExists(jobId);
  if (exists) {
    workerLogger.info({ jobId }, 'Micro-preview already exists, skipping generation');
    return null;
  }

  // Extract micro-text
  const { microText, remainingText } = extractMicroText(text);

  workerLogger.info({
    jobId,
    microTextLength: microText.length,
    remainingTextLength: remainingText.length,
  }, 'ElevenLabs: generating micro-preview');

  const microStart = Date.now();

  // Generate micro audio (non-streaming for simplicity - it's small)
  const microRequest: ElevenLabsRequest = {
    text: microText,
    voiceId,
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  };

  const microResult = await elevenLabs.synthesizeWithMetrics(microRequest);
  const microInferenceMs = Date.now() - microStart;

  // Log TTFB metrics
  logTTFBMetrics(jobId, microResult.metrics, 'elevenlabs-micro');

  // Upload micro immediately
  const microPath = `audio/jobs/${jobId}/micro.mp3`;
  await uploadAudioToCache(microPath, microResult.audioBuffer, 'mp3');

  // Get micro duration
  const microDurationSec = await getAudioDuration(microResult.audioBuffer);

  // Update job to partial_ready so iOS can start playing ASAP
  await supabase
    .from('tts_jobs')
    .update({
      status: 'partial_ready',
      preview_audio_path: microPath,
      preview_duration_sec: microDurationSec,
      progress_sec: microDurationSec,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  recordPartialReady(jobId, microDurationSec);

  workerLogger.info({
    jobId,
    microPath,
    microSize: microResult.audioBuffer.length,
    microDurationSec,
    microInferenceMs,
    ttfb_ms: microResult.metrics.ttfb_ms,
  }, 'ElevenLabs: micro-preview ready and uploaded');

  return {
    microBuffer: microResult.audioBuffer,
    microPath,
    microDurationSec,
    remainingText,
  };
}

/**
 * Generate full audio (micro + remaining) and finalize job.
 * Called after micro-preview is already uploaded.
 */
async function generateFullAudio(
  jobId: string,
  fullText: string,
  voiceId: string,
  microBuffer: Buffer | null
): Promise<{ fullBuffer: Buffer; fullPath: string; durationSec: number }> {
  const elevenLabs = getElevenLabsClient();
  if (!elevenLabs) {
    throw new Error('ElevenLabs not configured');
  }

  workerLogger.info({
    jobId,
    fullTextLength: fullText.length,
    hasMicroBuffer: !!microBuffer,
  }, 'ElevenLabs: generating full audio');

  const fullStart = Date.now();

  // Generate full audio
  const fullRequest: ElevenLabsRequest = {
    text: fullText,
    voiceId,
    voiceSettings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  };

  const fullResult = await elevenLabs.synthesizeWithMetrics(fullRequest);
  const fullInferenceMs = Date.now() - fullStart;

  // Log TTFB metrics
  logTTFBMetrics(jobId, fullResult.metrics, 'elevenlabs-full');

  // Upload full audio
  const fullPath = `audio/jobs/${jobId}/full.mp3`;
  await uploadAudioToCache(fullPath, fullResult.audioBuffer, 'mp3');

  // Get full duration
  const durationSec = await getAudioDuration(fullResult.audioBuffer);

  workerLogger.info({
    jobId,
    fullPath,
    fullSize: fullResult.audioBuffer.length,
    durationSec,
    fullInferenceMs,
    ttfb_ms: fullResult.metrics.ttfb_ms,
  }, 'ElevenLabs: full audio ready and uploaded');

  return {
    fullBuffer: fullResult.audioBuffer,
    fullPath,
    durationSec,
  };
}

/**
 * Synthesize using ElevenLabs with micro-first strategy.
 *
 * Key optimizations for v1:
 * 1. Generate micro-preview FIRST (small, fast) → partial_ready
 * 2. Then generate full audio in background → ready
 * 3. ElevenLabs returns MP3 directly - no WAV conversion needed
 * 4. Short Supabase connections - upload micro, then full separately
 * 5. Idempotency - skip micro if already exists
 */
async function synthesizeWithElevenLabs(
  jobId: string,
  text: string,
  voiceId: string,
  speed: number,
  cacheKey: string,
  isShortText: boolean
): Promise<{ previewPath?: string; fullPath: string; durationSec: number; mp3Size: number }> {
  const elevenLabs = getElevenLabsClient();
  if (!elevenLabs) {
    throw new Error('ElevenLabs not configured');
  }

  // V1: Micro-first enabled for faster time-to-first-audio
  // Fixed EPIPE crash by using duration estimation instead of ffprobe
  const MICRO_FIRST_ENABLED = true;

  if (!MICRO_FIRST_ENABLED || isShortText) {
    // Direct synthesis for all text (micro-first disabled)
    workerLogger.info({ jobId, textLength: text.length, microFirstEnabled: MICRO_FIRST_ENABLED }, 'ElevenLabs: synthesizing text directly');

    const inferenceStart = Date.now();
    workerLogger.info({ jobId }, 'ElevenLabs: [STEP 1] calling synthesizeWithMetrics');

    const result = await elevenLabs.synthesizeWithMetrics({
      text,
      voiceId,
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    });
    const inferenceMs = Date.now() - inferenceStart;

    workerLogger.info({ jobId }, 'ElevenLabs: [STEP 2] synthesis returned successfully');

    // Log TTFB metrics
    logTTFBMetrics(jobId, result.metrics, 'elevenlabs-short');

    workerLogger.info({
      jobId,
      inferenceMs,
      mp3Size: result.audioBuffer.length,
      ttfb_ms: result.metrics.ttfb_ms,
    }, 'ElevenLabs: short text synthesis complete');

    // Upload directly to final path
    const fullPath = `audio/jobs/${jobId}/full.mp3`;
    workerLogger.info({ jobId, fullPath, bufferSize: result.audioBuffer.length }, 'ElevenLabs: [STEP 3] uploading to storage');

    await uploadAudioToCache(fullPath, result.audioBuffer, 'mp3');

    workerLogger.info({ jobId }, 'ElevenLabs: [STEP 4] upload complete, getting duration');

    // Get duration from MP3
    const durationSec = await getAudioDuration(result.audioBuffer);

    workerLogger.info({ jobId, durationSec }, 'ElevenLabs: [STEP 5] duration calculated');

    return {
      fullPath,
      durationSec,
      mp3Size: result.audioBuffer.length,
    };
  }

  // For longer text, use MICRO-FIRST strategy:
  // 1. Generate micro-preview (fast, ~200 chars)
  // 2. Upload micro and update to partial_ready
  // 3. Generate full audio
  // 4. Upload full and update to ready

  workerLogger.info({ jobId, textLength: text.length }, 'ElevenLabs: using micro-first strategy');

  let microResult: Awaited<ReturnType<typeof generateMicroPreview>> = null;
  let fullResult: Awaited<ReturnType<typeof generateFullAudio>>;

  try {
    // Step 1: Generate micro-preview
    workerLogger.info({ jobId }, 'ElevenLabs: starting micro-preview generation');
    microResult = await generateMicroPreview(jobId, text, voiceId);
    workerLogger.info({ jobId, microPath: microResult?.microPath }, 'ElevenLabs: micro-preview complete');
  } catch (microError) {
    workerLogger.error({ jobId, error: microError instanceof Error ? microError.message : 'Unknown' }, 'ElevenLabs: micro-preview failed');
    throw microError;
  }

  try {
    // Step 2: Generate full audio
    // We generate the FULL text (not just remaining) to avoid audio discontinuity
    // The micro was just for fast preview - full is the complete audio
    workerLogger.info({ jobId }, 'ElevenLabs: starting full audio generation');
    fullResult = await generateFullAudio(jobId, text, voiceId, microResult?.microBuffer ?? null);
    workerLogger.info({ jobId, fullPath: fullResult.fullPath }, 'ElevenLabs: full audio complete');
  } catch (fullError) {
    workerLogger.error({ jobId, error: fullError instanceof Error ? fullError.message : 'Unknown' }, 'ElevenLabs: full audio failed');
    throw fullError;
  }

  return {
    previewPath: microResult?.microPath,
    fullPath: fullResult.fullPath,
    durationSec: fullResult.durationSec,
    mp3Size: fullResult.fullBuffer.length,
  };
}

/**
 * Process job using ElevenLabs (v1 production).
 */
async function processJobWithElevenLabs(
  jobId: string,
  text: string,
  voiceId: string,
  modelId: string,
  speed: number,
  cacheKey: string,
  charCount: number
): Promise<void> {
  const isShortText = charCount < SHORT_TEXT_THRESHOLD;

  workerLogger.info({
    jobId,
    voiceId,
    charCount,
    isShortText,
    provider: 'elevenlabs',
  }, 'Processing job with ElevenLabs');

  const inferenceStart = Date.now();

  const result = await synthesizeWithElevenLabs(
    jobId,
    text,
    voiceId,
    speed,
    cacheKey,
    isShortText
  );

  const inferenceMs = Date.now() - inferenceStart;

  // Record metrics
  recordSegmentInference(jobId, 0, inferenceMs, false);
  recordInferenceLatency('elevenlabs', inferenceMs, false);

  // Update cache entry
  await upsertCacheEntry({
    cacheKey,
    audioPath: result.fullPath,
    format: 'mp3',
    durationSec: result.durationSec,
    fileSizeBytes: result.mp3Size,
    voiceId,
    modelId: 'elevenlabs',
    speed,
    textHash: cacheKey,
  });

  // Update job to ready
  await updateTTSJobProgress({
    jobId,
    status: 'ready',
    audioPath: result.fullPath,
    durationSec: result.durationSec,
  });

  // Also update full_audio_path
  await supabase
    .from('tts_jobs')
    .update({
      full_audio_path: result.fullPath,
    })
    .eq('id', jobId);

  recordJobReady(jobId, result.durationSec, result.mp3Size, 1);

  workerLogger.info({
    jobId,
    durationSec: result.durationSec,
    mp3Size: result.mp3Size,
    inferenceMs,
  }, 'ElevenLabs job completed');
}

// ============================================================================
// Job Processing
// ============================================================================

/**
 * Process a job with preview-first approach.
 */
async function processJob(message: TTSJobMessage): Promise<void> {
  const { jobId, attempt } = message;

  workerLogger.info({ jobId, attempt }, 'Processing job from queue');

  // 1. Get job details from database
  const { data: jobData, error: jobError } = await supabase
    .from('tts_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (jobError || !jobData) {
    workerLogger.error({ error: jobError, jobId }, 'Job not found in database');
    return;
  }

  // Check if job is already completed or failed
  if (jobData.status === 'ready' || jobData.status === 'failed') {
    workerLogger.info({ jobId, status: jobData.status }, 'Job already completed, skipping');
    return;
  }

  // Extract job metadata for metrics
  const voiceId = jobData.voice_id as string;
  const modelId = jobData.model_id as string;
  const charCount = jobData.input_char_count as number;
  const userId = jobData.user_id as string;

  // Initialize metrics for this job (uses created_at as queued_at)
  initJobMetrics(jobId, userId, voiceId, modelId, charCount);

  // 2. Update to processing status
  const { error: updateError } = await supabase
    .from('tts_jobs')
    .update({
      status: 'processing',
      started_at: new Date().toISOString(),
      retry_count: attempt - 1,
    })
    .eq('id', jobId);

  // Record processing start for metrics
  recordProcessingStart(jobId, WORKER_INSTANCE);

  if (updateError) {
    workerLogger.error({ error: updateError, jobId }, 'Failed to update job status');
    throw new Error('Failed to update job status');
  }

  const speed = jobData.speed as number;
  const cacheKey = jobData.cache_key as string;

  workerLogger.info({ jobId, voiceId, charCount, attempt }, 'Processing TTS job');

  try {
    // 3. Get text from temporary storage
    const { data: textData, error: textError } = await supabase
      .from('tts_job_texts')
      .select('text')
      .eq('job_id', jobId)
      .single();

    if (textError || !textData?.text) {
      throw new Error('Job text not found - ensure text is stored when creating job');
    }

    const text = textData.text as string;

    // 4. Build voice config for TTS provider
    const voice: DBVoice = {
      id: voiceId,
      name: voiceId,
      description: null,
      style: 'conversational',
      category: 'general',
      provider: 'selfhosted',
      provider_voice_id: voiceId,
      provider_model_id: modelId,
      language: 'en-US',
      gender: null,
      is_premium: false,
      tier_required: 'free',
      settings: {},
      sample_audio_url: null,
      sample_text: '',
      is_active: true,
      sort_order: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // 5. Choose synthesis provider based on TTS_PROVIDER env var
    const configuredProvider = getConfiguredProvider();
    workerLogger.info({ jobId, charCount, provider: configuredProvider }, 'Selected TTS provider');

    if (configuredProvider === 'elevenlabs') {
      await processJobWithElevenLabs(jobId, text, voiceId, modelId, speed, cacheKey, charCount);
    } else if (charCount < SHORT_TEXT_THRESHOLD) {
      // Self-hosted for short text
      workerLogger.info({ jobId, charCount }, 'Short text, skipping preview and generating full audio');
      await processShortText(jobId, text, voice, speed, cacheKey, modelId);
    } else {
      // Fallback: Self-hosted preview-first for longer text
      workerLogger.info({ jobId, charCount }, 'Long text, using preview-first approach');
      await processWithPreview(jobId, text, voice, speed, cacheKey, modelId);
    }

    // 7. Clean up temporary text storage
    await supabase
      .from('tts_job_texts')
      .delete()
      .eq('job_id', jobId);

    // Track success for failure rate metrics
    trackJobResult(voiceId, modelId, true);

    workerLogger.info({ jobId, attempt }, 'Job completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    workerLogger.error({ error, jobId, attempt }, 'Job processing failed');

    // Record failure metrics
    recordJobFailure(jobId, 'SYNTHESIS_FAILED', errorMessage, voiceId, modelId);
    trackJobResult(voiceId, modelId, false, errorMessage);

    // Try to retry if we haven't exceeded max attempts
    const retried = await republishForRetry(jobId, attempt, workerConfig.maxRetries);

    if (retried) {
      await supabase
        .from('tts_jobs')
        .update({
          status: 'queued',
          retry_count: attempt,
          error_message: `Retry ${attempt + 1}/${workerConfig.maxRetries}: ${errorMessage}`,
        })
        .eq('id', jobId);

      workerLogger.info({ jobId, nextAttempt: attempt + 1 }, 'Job queued for retry');
    } else {
      await updateTTSJobProgress({
        jobId,
        status: 'failed',
        errorCode: 'SYNTHESIS_FAILED',
        errorMessage: `Failed after ${attempt} attempts: ${errorMessage}`,
      });

      workerLogger.error({ jobId, attempt }, 'Job failed permanently after max retries');
    }

    throw error;
  }
}

/**
 * Process short text directly without preview.
 */
async function processShortText(
  jobId: string,
  text: string,
  voice: DBVoice,
  speed: number,
  cacheKey: string,
  modelId: string
): Promise<void> {
  workerLogger.info({ jobId, gpuAvailable: ttsProvider.isGpuAvailable() }, 'Starting short text synthesis');

  // Track inference timing
  const inferenceStart = Date.now();

  const result = await ttsProvider.synthesizeWithFallback({
    text,
    voiceId: voice.provider_voice_id,
    modelId: voice.provider_model_id ?? undefined,
    settings: voice.settings,
    speed,
  });

  const inferenceMs = Date.now() - inferenceStart;

  // Record segment inference metrics (short text = 1 segment)
  recordSegmentInference(jobId, 0, inferenceMs, result.usedGpu);
  recordInferenceLatency(modelId, inferenceMs, result.usedGpu);

  workerLogger.info({ jobId, wavSize: result.audioBuffer.length, usedGpu: result.usedGpu, inferenceMs }, 'Converting to MP3');
  const mp3Buffer = await convertWavToMp3(result.audioBuffer);

  const durationSec = await getAudioDuration(mp3Buffer);

  const audioPath = generateAudioPath(cacheKey, 'mp3');
  workerLogger.info({ jobId, audioPath, mp3Size: mp3Buffer.length }, 'Uploading to storage');

  await uploadAudioToCache(audioPath, mp3Buffer, 'mp3');

  await upsertCacheEntry({
    cacheKey,
    audioPath,
    format: 'mp3',
    durationSec,
    fileSizeBytes: mp3Buffer.length,
    voiceId: voice.id,
    modelId: voice.provider_model_id || 'kokoro',
    speed,
    textHash: cacheKey,
  });

  await updateTTSJobProgress({
    jobId,
    status: 'ready',
    audioPath,
    durationSec,
  });

  // Record job ready metrics
  recordJobReady(jobId, durationSec, mp3Buffer.length, 1);

  workerLogger.info({ jobId, durationSec, mp3Size: mp3Buffer.length }, 'Short text job completed');
}

/**
 * Process long text with preview-first approach.
 */
async function processWithPreview(
  jobId: string,
  text: string,
  voice: DBVoice,
  speed: number,
  cacheKey: string,
  modelId: string
): Promise<void> {
  // 1. Split text into sentences
  const sentences = splitIntoSentences(text);
  workerLogger.info({ jobId, sentenceCount: sentences.length }, 'Split text into sentences');

  // 2. Select sentences for preview
  const { previewSentences, remainingSentences } = selectPreviewSentences(sentences, speed);
  const previewText = previewSentences.join(' ');
  const remainingText = remainingSentences.join(' ');

  workerLogger.info({
    jobId,
    previewSentences: previewSentences.length,
    remainingSentences: remainingSentences.length,
    previewChars: previewText.length,
    remainingChars: remainingText.length,
  }, 'Selected preview sentences');

  // 3. Generate preview audio with timing
  workerLogger.info({ jobId, gpuAvailable: ttsProvider.isGpuAvailable() }, 'Generating preview audio');
  const previewInferenceStart = Date.now();

  const previewResult = await ttsProvider.synthesizeWithFallback({
    text: previewText,
    voiceId: voice.provider_voice_id,
    modelId: voice.provider_model_id ?? undefined,
    settings: voice.settings,
    speed,
  });

  const previewInferenceMs = Date.now() - previewInferenceStart;
  recordSegmentInference(jobId, 0, previewInferenceMs, previewResult.usedGpu);
  recordInferenceLatency(modelId, previewInferenceMs, previewResult.usedGpu);

  workerLogger.info({ jobId, usedGpu: previewResult.usedGpu, inferenceMs: previewInferenceMs }, 'Preview audio generated');
  const previewWav = previewResult.audioBuffer;

  // 4. Convert preview to MP3 and upload
  workerLogger.info({ jobId, wavSize: previewWav.length }, 'Converting preview to MP3');
  const previewMp3 = await convertWavToMp3(previewWav);
  const previewDurationSec = await getAudioDuration(previewMp3);

  const previewPath = `audio/jobs/${jobId}/preview.mp3`;
  workerLogger.info({ jobId, previewPath, mp3Size: previewMp3.length }, 'Uploading preview');
  await uploadAudioToCache(previewPath, previewMp3, 'mp3');

  // 5. Update job to partial_ready
  await supabase
    .from('tts_jobs')
    .update({
      status: 'partial_ready',
      preview_audio_path: previewPath,
      preview_duration_sec: previewDurationSec,
      progress_sec: previewDurationSec,
      chunks_total: sentences.length,
      chunks_completed: previewSentences.length,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  // Record partial ready metrics
  recordPartialReady(jobId, previewDurationSec);

  workerLogger.info({ jobId, previewDurationSec }, 'Preview uploaded, status: partial_ready');

  // 6. If no remaining text, we're done
  if (!remainingText || remainingText.trim().length === 0) {
    const fullPath = `audio/jobs/${jobId}/full.mp3`;
    await uploadAudioToCache(fullPath, previewMp3, 'mp3');

    await upsertCacheEntry({
      cacheKey,
      audioPath: fullPath,
      format: 'mp3',
      durationSec: previewDurationSec,
      fileSizeBytes: previewMp3.length,
      voiceId: voice.id,
      modelId: voice.provider_model_id || 'kokoro',
      speed,
      textHash: cacheKey,
    });

    await updateTTSJobProgress({
      jobId,
      status: 'ready',
      audioPath: fullPath,
      durationSec: previewDurationSec,
    });

    // Also update full_audio_path
    await supabase
      .from('tts_jobs')
      .update({
        full_audio_path: fullPath,
      })
      .eq('id', jobId);

    // Record job ready metrics
    recordJobReady(jobId, previewDurationSec, previewMp3.length, sentences.length);

    workerLogger.info({ jobId, durationSec: previewDurationSec }, 'Preview was complete, job ready');
    return;
  }

  // 7. Generate remaining audio with timing
  workerLogger.info({ jobId, remainingChars: remainingText.length, gpuAvailable: ttsProvider.isGpuAvailable() }, 'Generating remaining audio');
  const remainingInferenceStart = Date.now();

  const remainingResult = await ttsProvider.synthesizeWithFallback({
    text: remainingText,
    voiceId: voice.provider_voice_id,
    modelId: voice.provider_model_id ?? undefined,
    settings: voice.settings,
    speed,
  });

  const remainingInferenceMs = Date.now() - remainingInferenceStart;
  recordSegmentInference(jobId, 1, remainingInferenceMs, remainingResult.usedGpu);
  recordInferenceLatency(modelId, remainingInferenceMs, remainingResult.usedGpu);

  workerLogger.info({ jobId, usedGpu: remainingResult.usedGpu, inferenceMs: remainingInferenceMs }, 'Remaining audio generated');
  const remainingWav = remainingResult.audioBuffer;

  // 8. Combine preview and remaining WAV
  workerLogger.info({ jobId }, 'Concatenating audio buffers');
  const fullWav = simpleWavConcat([previewWav, remainingWav]);

  // 9. Convert full audio to MP3
  workerLogger.info({ jobId, fullWavSize: fullWav.length }, 'Converting full audio to MP3');
  const fullMp3 = await convertWavToMp3(fullWav);
  workerLogger.info({ jobId, mp3Size: fullMp3.length }, 'Full audio MP3 conversion complete');
  const fullDurationSec = await getAudioDuration(fullMp3);
  workerLogger.info({ jobId, fullDurationSec }, 'Full audio duration calculated');

  // 10. Upload full audio
  const fullPath = `audio/jobs/${jobId}/full.mp3`;
  workerLogger.info({ jobId, fullPath, mp3Size: fullMp3.length }, 'Uploading full audio');
  await uploadAudioToCache(fullPath, fullMp3, 'mp3');

  // 11. Update cache entry
  await upsertCacheEntry({
    cacheKey,
    audioPath: fullPath,
    format: 'mp3',
    durationSec: fullDurationSec,
    fileSizeBytes: fullMp3.length,
    voiceId: voice.id,
    modelId: voice.provider_model_id || 'kokoro',
    speed,
    textHash: cacheKey,
  });

  // 12. Update job to ready
  await updateTTSJobProgress({
    jobId,
    status: 'ready',
    audioPath: fullPath,
    durationSec: fullDurationSec,
  });

  // Also update full_audio_path
  await supabase
    .from('tts_jobs')
    .update({
      full_audio_path: fullPath,
      chunks_completed: sentences.length,
    })
    .eq('id', jobId);

  // Record job ready metrics
  recordJobReady(jobId, fullDurationSec, fullMp3.length, sentences.length);

  workerLogger.info({
    jobId,
    previewDurationSec,
    fullDurationSec,
    previewMp3Size: previewMp3.length,
    fullMp3Size: fullMp3.length,
  }, 'Full audio uploaded, job ready');
}

// ============================================================================
// Stuck Job Handling
// ============================================================================

async function checkForStuckJobs(): Promise<void> {
  const cutoffTime = new Date(Date.now() - workerConfig.stuckJobTimeoutMs).toISOString();

  const { data: stuckJobs, error } = await supabase
    .from('tts_jobs')
    .select('id, started_at, retry_count')
    .eq('status', 'processing')
    .lt('started_at', cutoffTime);

  if (error) {
    workerLogger.error({ error }, 'Failed to check for stuck jobs');
    return;
  }

  if (!stuckJobs || stuckJobs.length === 0) {
    return;
  }

  workerLogger.warn({ count: stuckJobs.length }, 'Found stuck jobs');

  for (const job of stuckJobs) {
    const retryCount = (job.retry_count || 0) + 1;

    if (retryCount >= workerConfig.maxRetries) {
      await updateTTSJobProgress({
        jobId: job.id,
        status: 'failed',
        errorCode: 'STUCK_JOB',
        errorMessage: `Job stuck in processing for over ${workerConfig.stuckJobTimeoutMs / 1000}s after ${retryCount} attempts`,
      });
      workerLogger.error({ jobId: job.id, retryCount }, 'Stuck job marked as failed');
    } else {
      const republished = await republishForRetry(job.id, retryCount, workerConfig.maxRetries);
      if (republished) {
        await supabase
          .from('tts_jobs')
          .update({
            status: 'queued',
            retry_count: retryCount,
          })
          .eq('id', job.id);
        workerLogger.info({ jobId: job.id, retryCount }, 'Stuck job requeued for retry');
      }
    }
  }
}

// ============================================================================
// Worker Lifecycle
// ============================================================================

export function startWorker(config?: Partial<WorkerConfig>): void {
  if (isRunning) {
    workerLogger.warn('Worker already running');
    return;
  }

  workerConfig = { ...DEFAULT_CONFIG, ...config };
  isRunning = true;

  workerLogger.info({ config: workerConfig, workerInstance: WORKER_INSTANCE }, 'Starting TTS job worker with Pub/Sub');

  // Start metrics reporting (logs summary every minute)
  startMetricsReporting(60_000);

  stopSubscription = startSubscription(processJob);
  stuckJobInterval = setInterval(checkForStuckJobs, 30000);
}

export function stopWorker(): void {
  if (!isRunning) {
    return;
  }

  isRunning = false;

  // Stop metrics reporting
  stopMetricsReporting();

  if (stopSubscription) {
    stopSubscription();
    stopSubscription = null;
  }

  if (stuckJobInterval) {
    clearInterval(stuckJobInterval);
    stuckJobInterval = null;
  }

  workerLogger.info('TTS job worker stopped');
}

export function isWorkerRunning(): boolean {
  return isRunning;
}

export async function processJobById(jobId: string): Promise<void> {
  const message: TTSJobMessage = {
    jobId,
    attempt: 1,
    publishedAt: new Date().toISOString(),
  };

  await processJob(message);
}

// Legacy exports
export { convertWavToMp3, getAudioDuration };
