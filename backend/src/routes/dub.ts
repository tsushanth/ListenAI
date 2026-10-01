// Dubbing v1: upload a source-language audio file, get back a target-language
// audio file with roughly the same segment timing. Pipeline:
//   1. STT  — transcribe + segment the source audio on the CALLER'S OWN Modal
//             deployment (POST /api/dub/deploy; lib/modalDeployments.ts). The
//             worker is the vendored worker-stt-prod (modal/dub_worker.py); it
//             verifies an HMAC session token, which this route mints itself with
//             that deployment's own secret (lib/dubSessionToken.ts).
//   2. MT   — translate each segment's text via Claude (mirrors extract.ts's
//             LLM cleanup pattern).
//   3. TTS  — synthesize each translated segment with the existing self-hosted
//             TTS pipeline, adjusting `speed` per segment so its synthesized
//             duration approximately matches the source segment's duration.
//   4. Concatenate the per-segment audio buffers in order and return one file.
//             (Each segment comes back from ttsProvider.synthesize as a full,
//             independent WAV file — see the PCM-splicing note below on why
//             this can't just be a raw Buffer.concat of those buffers.)
//
// Explicitly OUT OF SCOPE for this pass (see report):
//   - Video. This is audio-in -> audio-out only. No muxing, no subtitles burn-in.
//   - Real forced alignment / phoneme-level timing. Speed-matching here is a
//     v1 approximation: whole-segment speed scaling, nothing more.
//   - Persistent job storage. Jobs live in an in-memory Map (like the STT
//     service this depends on, this is a first pass) — a process restart
//     loses in-flight jobs and this does not scale past a single instance.
//     tts.ts's job pattern uses a `tts_jobs` Postgres table; a real v2 of
//     dubbing should get its own `dub_jobs` table and migration instead.
//
// STT NOTE: the standalone /api/stt product (stt.ts) still uses the shared gateway-fronted worker. Dubbing no longer
// does: its speech-to-text step runs on the user's own deployment, and only that step is a Modal resource (translation
// is Claude, synthesis is the platform's TTS).

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import { getDeploymentManager, DeploymentRequiredError } from '../lib/modalDeployments.js';
import { mintDubSessionToken } from '../lib/dubSessionToken.js';
import { recordModalUsage } from '../lib/modalUsage.js';
import { mountDeploymentRoutes } from './deployments.js';
import { logger } from '../lib/logger.js';
import { ttsProvider } from '../lib/ttsProviderClient.js';
import { normalizeVoiceId, getDefaultVoiceId } from '../lib/voiceMapping.js';
import { uploadAudioToCache, getSignedAudioUrl } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportDubbingUsage } from '../lib/realtimeTtsBilling.js';
import type { AuthenticatedRequest, DBVoice } from '../types/index.js';
import { ValidationError, NotFoundError } from '../types/index.js';

const dubLogger = logger.child({ module: 'dub' });

// ============================================================================
// Config / external service client
// ============================================================================

const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;
const TRANSLATION_MODEL = 'claude-sonnet-4-6';

const MAX_AUDIO_MB = 50;
const MAX_SEGMENT_CHARS = 2000;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2.0; // narrower than tts.ts's 3.0 cap — large speed-ups mangle intelligibility
const CHARS_PER_SECOND_AT_SPEED_1 = 12.5; // matches config.ts's CHARS_PER_SECOND; used to estimate natural TTS duration before synthesizing

interface SttSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
}

interface SttResult {
  language: string | null;
  /** Total audio length in seconds (worker-reported, else the end of the last segment). Billing basis. */
  durationSec: number;
  segments: SttSegment[];
  /** GPU seconds the worker reports for this request (shadow-mode usage), if it said. */
  gpuSeconds: number | null;
  /** The deployment that served it, so usage can be attributed. */
  deploymentId: string;
}

/**
 * Transcribe and segment the source audio on the job owner's own Modal deployment. The worker's response has
 * `segments: [{ id, start, end, text }, ...]` (see stt.ts's TranscribeResult); mapped down to this file's simpler
 * SttSegment shape since dubbing doesn't need segment ids.
 */
async function transcribeSourceAudio(
  audioBuffer: Buffer,
  _filename: string,
  mimetype: string,
  sourceLanguage: string | undefined,
  userId: string,
  jobId: string
): Promise<SttResult> {
  const manager = getDeploymentManager();
  const target = await manager.resolveTarget(userId, 'dub');
  if (!target) throw new DeploymentRequiredError('dub');
  const token = mintDubSessionToken(target.secret, `dub:${userId}:${jobId}`);
  const qs = new URLSearchParams();
  if (sourceLanguage) qs.set('language', sourceLanguage);

  const res = await fetch(`${target.url}/v1/stt?${qs.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimetype || 'application/octet-stream' },
    body: new Uint8Array(audioBuffer),
    signal: AbortSignal.timeout(15 * 60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dub STT worker returned HTTP ${res.status}: ${text}`);
  }

  // Activity: keep the deployment alive while a dub is running (throttled, not a write per call).
  await manager.touch(target).catch((err) => dubLogger.warn({ err }, 'failed to record deployment activity (non-critical)'));

  const body = (await res.json()) as {
    language: string | null;
    duration?: number;
    gpu_seconds?: number;
    segments?: Array<{ id: number; start: number; end: number; text: string }>;
  };
  if (!Array.isArray(body.segments)) {
    throw new Error('dub STT worker returned an unexpected response shape (missing segments[])');
  }
  const segments = body.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
  const lastEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const durationSec = typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration > 0
    ? Math.max(body.duration, lastEnd)
    : lastEnd;
  const gpuSeconds = typeof body.gpu_seconds === 'number' && Number.isFinite(body.gpu_seconds) && body.gpu_seconds >= 0 ? body.gpu_seconds : null;
  return { language: body.language, durationSec, segments, gpuSeconds, deploymentId: target.deploymentId };
}

/**
 * Translate segment texts with Claude. Mirrors extract.ts's
 * `cleanContentWithLLM` pattern (system prompt + single completion call) but
 * translates a batch of segments at once, asking for a JSON array back so
 * segment boundaries survive translation instead of drifting if we
 * concatenated text and re-split it ourselves.
 */
async function translateSegments(
  segments: SttSegment[],
  targetLanguage: string
): Promise<string[]> {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY is not configured; cannot translate dubbing segments.');
  }
  if (segments.length === 0) return [];

  const systemPrompt = `You are a professional dubbing translator. You will receive a JSON array of transcript segments from a spoken-audio source.

Translate each segment's "text" into ${targetLanguage}. Rules:
1. Return a JSON array of strings, same length and same order as the input, with ONLY the translated text for each segment.
2. Keep each translation natural to SPEAK aloud (this is for dubbing, not subtitles) — prefer phrasing a speaker would actually say.
3. Do not merge, split, reorder, or drop segments. If a segment is empty or non-speech (e.g. "[music]"), return an empty string for it.
4. Do not add commentary, numbering, or explanations. Return ONLY the JSON array of strings.`;

  const userPrompt = JSON.stringify(segments.map((s) => s.text));

  const completion = await anthropic.messages.create({
    model: TRANSLATION_MODEL,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 8000,
    temperature: 0.1,
  });

  const firstBlock = completion.content[0];
  const raw = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';

  let parsed: unknown;
  try {
    // Claude sometimes wraps JSON in a fenced code block despite instructions; strip it defensively.
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Translation response was not valid JSON: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length !== segments.length) {
    throw new Error(
      `Translation response had ${Array.isArray(parsed) ? parsed.length : 'non-array'} entries, expected ${segments.length}`
    );
  }

  return parsed.map((v) => (typeof v === 'string' ? v : ''));
}

/**
 * Synthesize one segment's translated text, adjusting `speed` so the
 * resulting audio approximately matches `targetDurationSec`.
 *
 * v1 approximation: we estimate "natural" (speed=1) duration from character
 * count using the same CHARS_PER_SECOND heuristic tts.ts already uses for
 * job wait estimates (there's no cheaper way to know real TTS duration
 * without actually synthesizing), then pick speed = natural / target,
 * clamped to [MIN_SPEED, MAX_SPEED]. We do NOT re-synthesize iteratively to
 * true up the estimate against actual output duration — one shot only.
 */
async function synthesizeSegment(
  text: string,
  voiceId: string,
  targetDurationSec: number
): Promise<{ audioBuffer: Buffer; durationMs?: number; speedUsed: number }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { audioBuffer: Buffer.alloc(0), speedUsed: 1 };
  }

  const naturalDurationSec = Math.max(trimmed.length / CHARS_PER_SECOND_AT_SPEED_1, 0.1);
  let speed = targetDurationSec > 0.05 ? naturalDurationSec / targetDurationSec : 1;
  speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));

  // ttsProvider.synthesize takes a DBVoice, not a raw provider request —
  // build a minimal one, same shape tts.ts constructs for the self-hosted
  // (Kokoro) path.
  const voice: DBVoice = {
    id: voiceId,
    name: 'Dubbing voice',
    description: 'Kokoro voice (dubbing)',
    style: 'conversational',
    category: 'general',
    provider: 'selfhosted',
    provider_voice_id: normalizeVoiceId(voiceId),
    provider_model_id: null,
    language: 'en-US',
    gender: null,
    is_premium: false,
    tier_required: 'free',
    settings: {},
    sample_audio_url: null,
    sample_text: '',
    sort_order: 1,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // NOTE: the selfhosted (Kokoro) TTS path ignores `format` entirely and
  // always returns WAV bytes regardless of what's requested here — confirmed
  // in ttsProviderClient.ts's synthesizeShort()/synthesizeLong(), both of
  // which hardcode `format: 'wav'` on their response. Requesting 'wav'
  // explicitly (rather than 'mp3', which was never actually honored) keeps
  // this call honest about what it actually gets back.
  const result = await ttsProvider.synthesize(voice, trimmed, { speed, format: 'wav' });

  return { audioBuffer: result.audioBuffer, durationMs: result.durationMs, speedUsed: speed };
}

// ============================================================================
// WAV splicing
// ============================================================================
//
// Each per-segment buffer from synthesizeSegment() is itself a complete,
// independent WAV file (RIFF header + fmt chunk + data chunk) — confirmed
// against ttsProviderClient.ts. A naive Buffer.concat() of these would glue
// multiple RIFF/WAVE headers back to back, which is not valid WAV: a
// standards-conforming reader stops at the first data chunk's declared
// length and ignores everything after it, silently truncating playback to
// just the first segment. To produce one genuinely valid file, we parse each
// segment's fmt/data chunks, concatenate the raw PCM payloads only, and
// write a single WAV header sized for the combined PCM data.

interface WavPcm {
  pcm: Buffer;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
}

/**
 * Parse a WAV buffer's `fmt ` and `data` chunks (searching chunk-by-chunk
 * rather than assuming fixed offsets, since an optional chunk like `LIST`
 * can appear before `data`). Returns null if `buffer` isn't a valid
 * RIFF/WAVE file or is too short to contain both required chunks.
 */
function parseWavPcm(buffer: Buffer): WavPcm | null {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let offset = 12;
  let numChannels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let pcm: Buffer | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(chunkStart + chunkSize, buffer.length);

    if (chunkId === 'fmt ') {
      numChannels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      pcm = buffer.subarray(chunkStart, chunkEnd);
    }

    // Chunks are word-aligned: a chunk with an odd size has one byte of padding after it.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (numChannels === undefined || sampleRate === undefined || bitsPerSample === undefined || !pcm) {
    return null;
  }
  return { pcm, numChannels, sampleRate, bitsPerSample };
}

/** Build a standard 44-byte canonical WAV header for the given PCM format/length. */
function buildWavHeader(opts: { numChannels: number; sampleRate: number; bitsPerSample: number; dataLength: number }): Buffer {
  const { numChannels, sampleRate, bitsPerSample, dataLength } = opts;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

/**
 * Splice a sequence of per-segment WAV buffers into one valid WAV file by
 * extracting each segment's PCM payload and re-wrapping the concatenated PCM
 * in a single header. Empty buffers (from empty/non-speech segments — see
 * synthesizeSegment) are skipped since they carry no header to parse.
 * Segments are expected to share the same format (they all come from the
 * same TTS voice/provider); if a segment doesn't parse as WAV, it's dropped
 * rather than corrupting the whole file.
 */
function spliceWavSegments(buffers: Buffer[]): Buffer {
  const parsed = buffers.map((b) => (b.length > 0 ? parseWavPcm(b) : null)).filter((p): p is WavPcm => p !== null);
  if (parsed.length === 0) {
    return Buffer.alloc(0);
  }

  const { numChannels, sampleRate, bitsPerSample } = parsed[0]!;
  const pcm = Buffer.concat(parsed.map((p) => p.pcm));
  const header = buildWavHeader({ numChannels, sampleRate, bitsPerSample, dataLength: pcm.length });
  return Buffer.concat([header, pcm]);
}

// ============================================================================
// Job store (in-memory — see file header note on why this is v1-only)
// ============================================================================

type DubJobStatus = 'processing' | 'ready' | 'failed';

interface DubSegmentResult {
  index: number;
  source_text: string;
  translated_text: string;
  start_sec: number;
  end_sec: number;
  speed_used: number;
}

interface DubJob {
  id: string;
  userId: string;
  status: DubJobStatus;
  targetLanguage: string;
  sourceLanguage: string | null;
  voiceId: string;
  createdAt: string;
  updatedAt: string;
  segments?: DubSegmentResult[];
  audioPath?: string;
  audioUrl?: string;
  error?: string;
}

const dubJobs = new Map<string, DubJob>();

// Best-effort cleanup so this doesn't leak memory across a long-running
// process — jobs older than an hour are dropped. Not a substitute for real
// persistence; see file header.
const JOB_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of dubJobs) {
    if (new Date(job.updatedAt).getTime() < cutoff) dubJobs.delete(id);
  }
}, 10 * 60 * 1000).unref?.();

function touchJob(job: DubJob) {
  job.updatedAt = new Date().toISOString();
}

// ============================================================================
// Orchestration
// ============================================================================

async function runDubJob(
  job: DubJob,
  audioBuffer: Buffer,
  filename: string,
  mimetype: string
): Promise<void> {
  try {
    // 1. STT
    const stt = await transcribeSourceAudio(audioBuffer, filename, mimetype, job.sourceLanguage ?? undefined, job.userId, job.id);
    // Shadow mode: record the measured GPU time. Not billed; compared against Modal's own bill (modalUsage.ts).
    if (stt.gpuSeconds !== null) {
      await recordModalUsage({ deploymentId: stt.deploymentId, userId: job.userId, service: 'dub', jobId: job.id, gpuSeconds: stt.gpuSeconds });
    }
    if (stt.segments.length === 0) {
      throw new Error('Transcription returned no segments — nothing to dub.');
    }

    // Guard against pathologically long segments blowing the translation prompt.
    const segments = stt.segments.map((s) => ({
      ...s,
      text: s.text.length > MAX_SEGMENT_CHARS ? s.text.slice(0, MAX_SEGMENT_CHARS) : s.text,
    }));

    // 2. Translate
    const translations = await translateSegments(segments, job.targetLanguage);

    // 3. Synthesize each segment with speed-matching
    const buffers: Buffer[] = [];
    const segmentResults: DubSegmentResult[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const translated = translations[i] ?? '';
      const targetDurationSec = Math.max(seg.end - seg.start, 0.1);

      const { audioBuffer: segAudio, speedUsed } = await synthesizeSegment(
        translated,
        job.voiceId,
        targetDurationSec
      );

      buffers.push(segAudio);
      segmentResults.push({
        index: i,
        source_text: seg.text,
        translated_text: translated,
        start_sec: seg.start,
        end_sec: seg.end,
        speed_used: speedUsed,
      });
    }

    // 4. Splice. v1 approximation: no silence-gap padding between segments
    // and no container-level remuxing (no ffmpeg in this repo — see file
    // header) — segments are placed back to back with no regard for the
    // source segment gaps. This is NOT a raw Buffer.concat of the per-segment
    // buffers though: each one is its own complete WAV file (RIFF header +
    // PCM data), so naive concatenation would glue multiple headers together
    // into an invalid file that most players truncate at the first segment.
    // spliceWavSegments() strips each segment down to its PCM payload and
    // wraps the combined PCM in a single valid header (see WAV splicing
    // section above) — not a substitute for real audio muxing.
    const finalAudio = spliceWavSegments(buffers);

    const audioPath = `audio/dubbing/${job.userId}/${job.id}.wav`;
    await uploadAudioToCache(audioPath, finalAudio, 'wav');
    const audioUrl = await getSignedAudioUrl(audioPath);

    job.segments = segmentResults;
    job.audioPath = audioPath;
    job.audioUrl = audioUrl ?? undefined;
    job.status = 'ready';
    touchJob(job);

    dubLogger.info(
      { jobId: job.id, segments: segmentResults.length, bytes: finalAudio.length },
      'Dubbing job completed'
    );

    // Billed per second of SOURCE audio (rounded up, with a minimum) on the character meter, see
    // AUDIO_JOB_PRICING in realtimeTtsBilling.ts. Fire-and-forget: never awaited into the job
    // result, and a metering failure must never turn a successful dub into a failed job.
    reportDubbingUsage(job.userId, stt.durationSec, job.id).catch((err: unknown) =>
      dubLogger.warn({ err, jobId: job.id, userId: job.userId }, 'Dubbing billing report failed (non-critical)')
    );
  } catch (error) {
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Unknown error';
    touchJob(job);
    dubLogger.error({ jobId: job.id, error }, 'Dubbing job failed');
  }
}

// ============================================================================
// Router
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => cb(null, true),
});

export const dubRouter = Router();

// Dark by default — this orchestrates existing TTS/Claude calls plus one
// external STT service; if that service or Claude aren't configured, 404
// rather than a confusing 500 mid-pipeline.
dubRouter.use((_req, res, next) => {
  if (!anthropic) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

// requireAuthOrApiKey (mounted in front of this router in index.ts) sets req.user (and req.userId); the shared deploy
// routes read req.userId.
function requireDubUser(req: Request, res: Response, next: NextFunction) {
  const r = req as Request & { userId?: string; user?: { id?: string } };
  r.userId ??= r.user?.id;
  if (!r.userId) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

// Self-serve lifecycle: POST/GET/DELETE /deploy brings up, reports on, and tears down the caller's own STT deployment.
mountDeploymentRoutes(dubRouter, 'dub', requireDubUser);

const submitBodySchema = z.object({
  target_language: z.string().min(2).max(40),
  source_language: z.string().min(2).max(10).optional(),
  voice_id: z.string().min(1).max(100).optional(),
});

// --------------------------------------------------------------------------
// POST /api/dub — submit source audio + target language, get a job id back
// --------------------------------------------------------------------------
dubRouter.post('/', upload.single('audio'), asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  if (!(await hasUsageAllowance(userId))) {
    res.status(402).json({ error: freeCreditsExhaustedMessage('dubbing') });
    return;
  }

  // The speech-to-text step runs on the caller's own Modal deployment (there is no shared worker).
  const manager = getDeploymentManager();
  const target = await manager.resolveTarget(userId, 'dub', { forNewWork: true });
  if (!target) {
    res.status(400).json({
      error: 'Dubbing is not deployed. Deploy first (POST /api/dub/deploy), wait until its status is "ready", then submit.',
      code: 'deployment_required',
    });
    return;
  }

  const file = req.file;

  if (!file || file.size < 1024) {
    throw new ValidationError('An "audio" file is required (multipart/form-data).');
  }

  const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mp3', 'audio/webm'];
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ValidationError(`Unsupported audio format: ${file.mimetype}`);
  }

  const parseResult = submitBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { target_language, source_language, voice_id } = parseResult.data;

  const job: DubJob = {
    id: randomUUID(),
    userId,
    status: 'processing',
    targetLanguage: target_language,
    sourceLanguage: source_language ?? null,
    voiceId: voice_id ?? getDefaultVoiceId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  dubJobs.set(job.id, job);
  await manager.touch(target, { job: true }).catch((err) => dubLogger.warn({ err }, 'failed to record deployment activity (non-critical)'));

  dubLogger.info(
    { jobId: job.id, userId, targetLanguage: target_language, sourceLanguage: source_language, bytes: file.size },
    'Dubbing job submitted'
  );

  // Fire-and-forget: async processing, client polls GET /api/dub/:jobId.
  // (No queue/worker infra for this feature yet — runs inline in this
  // process, same tradeoff as the in-memory job store above.)
  void runDubJob(job, file.buffer, file.originalname || 'source-audio', file.mimetype);

  res.status(202).json({
    job_id: job.id,
    status: job.status,
  });
}));

// --------------------------------------------------------------------------
// GET /api/dub/:jobId — poll job status / get result
// --------------------------------------------------------------------------
dubRouter.get('/:jobId', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { jobId } = req.params;
  if (!jobId) {
    throw new ValidationError('Job ID is required');
  }

  const job = dubJobs.get(jobId);
  if (!job || job.userId !== userId) {
    throw new NotFoundError('Dubbing job');
  }

  res.json({
    job_id: job.id,
    status: job.status,
    target_language: job.targetLanguage,
    source_language: job.sourceLanguage,
    audio_url: job.audioUrl,
    segments: job.segments,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  });
}));
