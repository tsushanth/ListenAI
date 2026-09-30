// Dubbing v1: upload a source-language audio file, get back a target-language
// audio file with roughly the same segment timing. Pipeline:
//   1. STT  — transcribe + segment the source audio, via the same gateway
//             session-token hand-off as stt.ts (worker-stt-prod does not
//             accept a static secret — see authorizeStt() below).
//   2. MT   — translate each segment's text via Claude (mirrors extract.ts's
//             LLM cleanup pattern).
//   3. TTS  — synthesize each translated segment with the existing self-hosted
//             TTS pipeline, adjusting `speed` per segment so its synthesized
//             duration approximately matches the source segment's duration.
//   4. Concatenate the per-segment audio buffers in order and return one file.
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
// STT NOTE: this route's transcribeSourceAudio()/authorizeStt() duplicate
// stt.ts's gateway-authorize logic locally rather than importing it, to keep
// this file's dependency surface small — both call the same external
// worker-stt-prod service the same way and share the STT_API_KEY config.
// Worth consolidating into a shared helper as a follow-up.

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { ttsProvider } from '../lib/ttsProviderClient.js';
import { normalizeVoiceId, getDefaultVoiceId } from '../lib/voiceMapping.js';
import { uploadAudioToCache, getSignedAudioUrl } from '../lib/supabaseClient.js';
import type { AuthenticatedRequest, DBVoice } from '../types/index.js';
import { ValidationError, NotFoundError } from '../types/index.js';

const dubLogger = logger.child({ module: 'dub' });

// ============================================================================
// Config / external service client
// ============================================================================

// worker-stt-prod does NOT accept a static bearer secret (confirmed against its own app.py: it
// verifies an HMAC session token minted by the gateway's POST /stt/authorize, same contract
// routes/stt.ts already uses). A STT_WORKER_URL/STT_WORKER_SECRET static-secret design would
// fail against the real worker every time - caught during a live end-to-end dubbing test.
// Reusing stt.ts's exact working gateway-authorize pattern and its already-provisioned
// STT_API_KEY instead of a second, broken integration path.
const STT_GATEWAY_URL = config.STT_GATEWAY_URL || 'https://api.readaloudai.org';
const STT_API_KEY = config.STT_API_KEY;

interface SttAuthorizeResult { token: string; url: string }

async function authorizeStt(): Promise<SttAuthorizeResult> {
  if (!STT_API_KEY) throw new Error('Speech-to-text is not configured; dubbing is not available in this environment.');
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${STT_GATEWAY_URL}/stt/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: STT_API_KEY, mode: 'batch' }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the speech-to-text gateway: ${(err as Error).message}`);
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw new Error(`STT authorize failed with HTTP ${upstream.status}: ${text}`);
  }
  const body = (await upstream.json().catch(() => null)) as { token?: string; url?: string } | null;
  if (!body?.token || !body.url) throw new Error('STT authorize returned an unexpected response');
  return { token: body.token, url: body.url };
}

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
  segments: SttSegment[];
}

/**
 * Transcribe and segment the source audio via worker-stt-prod, using the same
 * gateway-authorize + raw-bytes-POST pattern as stt.ts's callWorker(). The
 * worker's actual response has `segments: [{ id, start, end, text }, ...]`
 * (see stt.ts's TranscribeResult) — mapped down to this file's simpler
 * SttSegment shape (start, end, text) since dubbing doesn't need segment ids.
 */
async function transcribeSourceAudio(
  audioBuffer: Buffer,
  _filename: string,
  mimetype: string,
  sourceLanguage: string | undefined
): Promise<SttResult> {
  const { token, url } = await authorizeStt();
  const qs = new URLSearchParams();
  if (sourceLanguage) qs.set('language', sourceLanguage);

  const res = await fetch(`${url}/v1/stt?${qs.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimetype || 'application/octet-stream' },
    body: new Uint8Array(audioBuffer),
    signal: AbortSignal.timeout(15 * 60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`worker-stt-prod returned HTTP ${res.status}: ${text}`);
  }

  const body = (await res.json()) as {
    language: string | null;
    segments?: Array<{ id: number; start: number; end: number; text: string }>;
  };
  if (!Array.isArray(body.segments)) {
    throw new Error('worker-stt-prod returned an unexpected response shape (missing segments[])');
  }
  return {
    language: body.language,
    segments: body.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
  };
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

  const result = await ttsProvider.synthesize(voice, trimmed, { speed, format: 'mp3' });

  return { audioBuffer: result.audioBuffer, durationMs: result.durationMs, speedUsed: speed };
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
    const stt = await transcribeSourceAudio(audioBuffer, filename, mimetype, job.sourceLanguage ?? undefined);
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

    // 4. Concatenate. v1 approximation: naive back-to-back byte concatenation
    // of MP3 buffers, no silence-gap padding between segments and no
    // container-level remuxing (no ffmpeg in this repo — see file header).
    // Most MP3 decoders tolerate concatenated frames fine for playback, but
    // this is not a substitute for real audio muxing.
    const finalAudio = Buffer.concat(buffers);

    const audioPath = `audio/dubbing/${job.userId}/${job.id}.mp3`;
    await uploadAudioToCache(audioPath, finalAudio, 'mp3');
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
  if (!STT_API_KEY || !anthropic) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
});

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
