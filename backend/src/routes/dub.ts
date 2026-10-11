// Dubbing: upload a source-language audio file, get back a target-language audio file on the source timeline.
// Pipeline:
//   1. STT  - transcribe + segment the source audio, via the same gateway session-token hand-off as stt.ts
//             (worker-stt-prod does not accept a static secret - see authorizeStt() below).
//   2. Clean - drop STT hallucinations / segments past the audio end, merge sub-second backchannels
//             (lib/dubTiming.ts sanitizeSegments).
//   3. MT   - translate each segment via Claude with a per-segment length budget (chars the target language
//             can speak in the source slot), one shorten pass for segments that blow the budget.
//   4. TTS  - synthesize each segment with the language-correct Kokoro voice (lib/dubLanguages.ts), measure its
//             real duration at speed 1 and re-synthesize at the speed that fits the source slot
//             (lib/dubPipeline.ts, ported from the S3 kit's arm C).
//   5. Place - lay segments on the source timeline with silence in the gaps, one 24 kHz mono WAV as long as
//             the source (lib/dubTiming.ts placeSegments).
//   SRT/VTT export: GET /api/dub/:jobId/subtitles.
//
// Still OUT OF SCOPE (see the PR notes):
//   - Video muxing, background-music preservation, voice cloning (S5), real diarization (the STT worker
//     returns no speaker labels; if a segment carries `speaker` we map it to a distinct stock voice).
//   - Persistent job storage. Jobs live in an in-memory Map: a process restart loses in-flight jobs and this
//     does not scale past a single instance. A real v2 should get a `dub_jobs` table.
//
// STT NOTE: transcribeSourceAudio()/authorizeStt() duplicate stt.ts's gateway-authorize logic locally rather
// than importing it, to keep this file's dependency surface small. Worth consolidating as a follow-up.

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { instrumentAnthropic, withFeature } from '../lib/llm.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { ttsProvider } from '../lib/ttsProviderClient.js';
import {
  resolveDubLanguage, assignSpeakerVoices, supportedDubLanguageList, type DubLanguage,
} from '../lib/dubLanguages.js';
import {
  sanitizeSegments, lengthBudget, toSrt, toVtt, type SanitizedSegment, type DropReason, type Cue,
} from '../lib/dubTiming.js';
import { fitAndPlace, type FitResult } from '../lib/dubPipeline.js';
import {
  buildTranslationSystemPrompt, buildTranslationUserPrompt, parseTranslationReply, overBudgetIndexes,
  chunkRanges, TRANSLATION_BATCH, type TranslationInputItem,
} from '../lib/dubTranslation.js';
import { probeAudioDurationSec } from '../lib/audioProbe.js';
import { createDubSynth } from '../lib/dubTts.js';
import { uploadAudioToCache, getSignedAudioUrl } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportDubbingUsage } from '../lib/realtimeTtsBilling.js';
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
  ? instrumentAnthropic(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }))
  : null;
const TRANSLATION_MODEL = 'claude-sonnet-4-6';

const MAX_AUDIO_MB = 50;
const MAX_SEGMENT_CHARS = 2000;

interface SttSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  /** Speaker label if the STT worker diarizes. worker-stt-prod does not today, so this is normally undefined. */
  speaker?: string;
}

interface SttResult {
  language: string | null;
  /** Total audio length in seconds (worker-reported, else the end of the last segment). Billing basis if nothing better is known. */
  durationSec: number;
  /** Duration reported by the worker itself, if any. Unlike durationSec this is not inflated by a hallucinated last segment. */
  reportedDurationSec: number | null;
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
    duration?: number;
    segments?: Array<{ id: number; start: number; end: number; text: string; speaker?: string | number | null }>;
  };
  if (!Array.isArray(body.segments)) {
    throw new Error('worker-stt-prod returned an unexpected response shape (missing segments[])');
  }
  const segments: SttSegment[] = body.segments.map((s) => ({
    start: s.start, end: s.end, text: s.text,
    ...(s.speaker !== undefined && s.speaker !== null && String(s.speaker) !== '' ? { speaker: String(s.speaker) } : {}),
  }));
  const lastEnd = segments.reduce((m, s) => Math.max(m, s.end), 0);
  const reported = typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration > 0 ? body.duration : null;
  const durationSec = reported !== null ? Math.max(reported, lastEnd) : lastEnd;
  return { language: body.language, durationSec, reportedDurationSec: reported, segments };
}

/**
 * Translate segment texts with Claude, with a per-segment length budget so the dub can fit the source slot
 * without a 2x speed-up. Batches of TRANSLATION_BATCH segments (a long job would otherwise risk the
 * max_tokens cap truncating the JSON); each batch retries once on a malformed/mismatched reply; segments
 * still far over budget get one shorten pass. Asks for a JSON array back so segment boundaries survive
 * translation instead of drifting if we concatenated text and re-split it ourselves.
 */
async function callClaudeForTranslations(system: string, items: TranslationInputItem[]): Promise<string[]> {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY is not configured; cannot translate dubbing segments.');
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const completion = await withFeature('dubbing', () => anthropic.messages.create({
      model: TRANSLATION_MODEL,
      system,
      messages: [{ role: 'user', content: buildTranslationUserPrompt(items) }],
      max_tokens: 8000,
      temperature: 0.1,
    }));
    const firstBlock = completion.content[0];
    const raw = firstBlock && firstBlock.type === 'text' ? firstBlock.text : '';
    try {
      return parseTranslationReply(raw, items.length);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error('Translation failed');
}

async function translateSegments(
  segments: SanitizedSegment[],
  lang: DubLanguage,
  sourceName: string
): Promise<{ translations: string[]; shortened: number }> {
  if (segments.length === 0) return { translations: [], shortened: 0 };
  const system = buildTranslationSystemPrompt(lang, sourceName);
  const items: TranslationInputItem[] = segments.map((s) => {
    const b = lengthBudget(s.end - s.start, lang.code);
    return { text: s.text, maxChars: b.maxChars, targetChars: b.targetChars };
  });

  const translations: string[] = [];
  for (const [from, to] of chunkRanges(items.length, TRANSLATION_BATCH)) {
    translations.push(...(await callClaudeForTranslations(system, items.slice(from, to))));
  }

  // One shorten pass for translations that are clearly over budget (they would otherwise force a clamped speed-up).
  const over = overBudgetIndexes(translations, items);
  if (over.length > 0) {
    try {
      const shortenSystem = `${system}\n\nThe "text" of each item below is ALREADY a ${lang.name} translation that is too long. Rewrite it in ${lang.name}, keeping the meaning but staying within max_chars.`;
      const shortened = await callClaudeForTranslations(
        shortenSystem,
        over.map((i) => ({ text: translations[i]!, maxChars: items[i]!.maxChars, targetChars: items[i]!.targetChars }))
      );
      let used = 0;
      over.forEach((i, k) => {
        const cand = shortened[k]!.trim();
        if (cand && cand.length < translations[i]!.length) { translations[i] = cand; used++; }
      });
      return { translations, shortened: used };
    } catch (err) {
      dubLogger.warn({ err }, 'Dub shorten pass failed (non-critical); using the over-budget translations');
    }
  }
  return { translations, shortened: 0 };
}

/**
 * Synthesize one piece of translated text through the self-hosted (Kokoro) provider and return the WAV.
 * The language and the voice id (Kokoro for English, Piper house voice for es/fr) are passed through as-is: before this fix the voice always said
 * language 'en-US' and normalizeVoiceId() coerced every non-American/British voice to am_adam.
 * (The selfhosted path ignores `format` and always returns WAV - see ttsProviderClient.ts.)
 */
async function synthesizeWav(lang: DubLanguage, text: string, voiceId: string, speed: number): Promise<Buffer> {
  const now = new Date().toISOString();
  const voice: DBVoice = {
    id: voiceId,
    name: 'Dubbing voice',
    description: 'Kokoro voice (dubbing)',
    style: 'conversational',
    category: 'general',
    provider: 'selfhosted',
    provider_voice_id: voiceId,
    provider_model_id: null,
    language: lang.bcp47,
    gender: null,
    is_premium: false,
    tier_required: 'free',
    // ttsProviderClient reads settings.language and sends it as the service's `language` field.
    settings: { language: lang.code },
    sample_audio_url: null,
    sample_text: '',
    sort_order: 1,
    is_active: true,
    created_at: now,
    updated_at: now,
  };
  const result = await ttsProvider.synthesize(voice, text, { speed, format: 'wav' });
  return result.audioBuffer;
}

// ============================================================================
// Job store (in-memory - see file header note on why this is v1-only)
// ============================================================================

type DubJobStatus = 'processing' | 'ready' | 'failed';

interface DubSegmentResult {
  index: number;
  /** Indexes of the original STT segments covered (more than one when sub-second backchannels were merged). */
  source_indexes: number[];
  source_text: string;
  translated_text: string;
  start_sec: number;
  end_sec: number;
  speed_used: number;
  /** Duration of the placed audio. */
  synth_sec: number;
  clamped: boolean;
  tts_calls: number;
  /** Where the segment actually starts in the dub, and how far that is from start_sec (drift >= 0). */
  placed_start_sec: number;
  drift_sec: number;
  speaker: string | null;
  voice_id: string;
  skipped?: string;
}

interface DubJob {
  id: string;
  userId: string;
  status: DubJobStatus;
  targetLanguage: string; // as submitted
  targetLanguageCode: DubLanguage['code'];
  sourceLanguage: string | null;
  /** voice_id requested by the caller (may be ignored if it is not a voice of the target language). */
  voiceId: string | null;
  createdAt: string;
  updatedAt: string;
  segments?: DubSegmentResult[];
  dropped?: Array<{ index: number; reason: DropReason; text: string }>;
  voices?: Array<{ speaker: string | null; voice_id: string }>;
  diarization?: 'stt_speaker_labels' | 'unavailable_single_voice';
  warnings?: string[];
  maxDriftSec?: number;
  audioDurationSec?: number | null;
  audioPath?: string;
  audioUrl?: string;
  error?: string;
}

const dubJobs = new Map<string, DubJob>();

// Best-effort cleanup so this doesn't leak memory across a long-running
// process - jobs older than an hour are dropped. Not a substitute for real
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
  lang: DubLanguage,
  audioBuffer: Buffer,
  filename: string,
  mimetype: string
): Promise<void> {
  try {
    // 1. STT
    const stt = await transcribeSourceAudio(audioBuffer, filename, mimetype, job.sourceLanguage ?? undefined);
    if (stt.segments.length === 0) {
      throw new Error('Transcription returned no segments - nothing to dub.');
    }

    // Independent audio length: the last STT segment end cannot be trusted (Whisper tail hallucinations).
    const probed = await probeAudioDurationSec(audioBuffer, mimetype);
    const audioDurationSec = probed ?? stt.reportedDurationSec;
    job.audioDurationSec = audioDurationSec;

    // 2. Clean: drop hallucinations / past-the-end segments, merge sub-second backchannels.
    const truncated = stt.segments.map((s) => ({
      ...s,
      text: s.text.length > MAX_SEGMENT_CHARS ? s.text.slice(0, MAX_SEGMENT_CHARS) : s.text,
    }));
    const { kept: segments, dropped } = sanitizeSegments(truncated, audioDurationSec);
    job.dropped = dropped.map((d) => ({ index: d.index, reason: d.reason, text: (stt.segments[d.index]?.text ?? '').slice(0, 200) }));
    if (segments.length === 0) {
      throw new Error('No usable speech segments after removing silence/hallucinated segments - nothing to dub.');
    }

    // 3. Voices: one stock voice per speaker label (a single voice when the STT output has no labels).
    const speakers: Array<string | undefined> = [];
    for (const s of segments) if (!speakers.includes(s.speaker)) speakers.push(s.speaker);
    const assignment = assignSpeakerVoices(lang, speakers, job.voiceId ?? undefined);
    const warnings: string[] = [];
    if (assignment.ignoredRequestedVoice) {
      warnings.push(`voice_id "${assignment.ignoredRequestedVoice}" is not a ${lang.name} voice and was ignored; using the default ${lang.name} voice.`);
    }
    if (assignment.collapsed) warnings.push(`More speakers than ${lang.name} stock voices: some speakers share a voice.`);
    if (lang.note) warnings.push(lang.note);
    job.diarization = speakers.some((sp) => sp !== undefined) ? 'stt_speaker_labels' : 'unavailable_single_voice';
    job.voices = speakers.map((sp) => ({ speaker: sp ?? null, voice_id: assignment.voiceBySpeaker.get(sp)! }));
    job.warnings = warnings;

    // 4. Translate (with length budget)
    const sourceCode = job.sourceLanguage ?? stt.language ?? 'en';
    const sourceName = resolveDubLanguage(sourceCode)?.name ?? sourceCode;
    const { translations } = await translateSegments(segments, lang, sourceName);

    // 5. Synthesize with measured-duration refit and place on the source timeline. Backend: DUB_TTS_BACKEND=gpu|cpu (lib/dubTts.ts).
    const synth = await createDubSynth(lang, {
      providerSynth: synthesizeWav,
      defaultGatewayUrl: STT_GATEWAY_URL,
      fallbackApiKey: STT_API_KEY,
    });
    const fit = await fitAndPlace({
      segments: segments.map((seg, i) => ({
        index: i,
        slotStart: seg.start,
        slotEnd: seg.end,
        text: translations[i] ?? '',
        speaker: seg.speaker,
        voiceId: assignment.voiceBySpeaker.get(seg.speaker)!,
      })),
      synth,
      trimSilence: lang.engine === 'piper',
      minSpeed: lang.speedRange.min,
      maxSpeed: lang.speedRange.max,
      sourceDurationSec: audioDurationSec ?? segments[segments.length - 1]!.end,
    });

    const segmentResults: DubSegmentResult[] = segments.map((seg, i) => {
      const f: FitResult = fit.segments[i]!;
      return {
        index: i,
        source_indexes: seg.sourceIndexes,
        source_text: seg.text,
        translated_text: translations[i] ?? '',
        start_sec: seg.start,
        end_sec: seg.end,
        speed_used: f.speedUsed,
        synth_sec: f.synthSec,
        clamped: f.clamped,
        tts_calls: f.ttsCalls,
        placed_start_sec: f.placedStartSec,
        drift_sec: f.driftSec,
        speaker: seg.speaker ?? null,
        voice_id: f.voiceId,
        ...(f.skipped ? { skipped: f.skipped } : {}),
      };
    });
    if (segmentResults.every((r) => r.skipped)) {
      throw new Error('Text-to-speech produced no audio for any segment.');
    }
    const skippedCount = segmentResults.filter((r) => r.skipped === 'undecodable_audio').length;
    if (skippedCount > 0) warnings.push(`${skippedCount} segment(s) could not be synthesized and are silent in the dub.`);

    const finalAudio = fit.wav;
    const audioPath = `audio/dubbing/${job.userId}/${job.id}.wav`;
    await uploadAudioToCache(audioPath, finalAudio, 'wav');
    const audioUrl = await getSignedAudioUrl(audioPath);

    job.segments = segmentResults;
    job.maxDriftSec = fit.maxDriftSec;
    job.audioPath = audioPath;
    job.audioUrl = audioUrl ?? undefined;
    job.status = 'ready';
    touchJob(job);

    dubLogger.info(
      { jobId: job.id, lang: lang.code, segments: segmentResults.length, dropped: dropped.length, maxDriftSec: fit.maxDriftSec, bytes: finalAudio.length },
      'Dubbing job completed'
    );

    // Billed per second of SOURCE audio (rounded up, with a minimum) on the character meter, see
    // AUDIO_JOB_PRICING in realtimeTtsBilling.ts. Use the independently known audio length when we have it
    // so a hallucinated tail segment is never billed. Fire-and-forget: a metering failure must never turn a
    // successful dub into a failed job.
    const billedSec = audioDurationSec ?? stt.durationSec;
    reportDubbingUsage(job.userId, billedSec, job.id).catch((err: unknown) =>
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

  if (!(await hasUsageAllowance(userId))) {
    res.status(402).json({ error: freeCreditsExhaustedMessage('dubbing') });
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

  const lang = resolveDubLanguage(target_language);
  if (!lang) {
    throw new ValidationError(
      `Target language "${target_language}" is not supported for dubbing. Supported: ${supportedDubLanguageList().join(', ')}.`,
      { supported: supportedDubLanguageList() }
    );
  }
  if (!lang.offered) {
    throw new ValidationError(
      `Dubbing into ${lang.name} is not offered yet. Offered: ${supportedDubLanguageList().join(', ')}.`,
      { supported: supportedDubLanguageList() }
    );
  }

  const job: DubJob = {
    id: randomUUID(),
    userId,
    status: 'processing',
    targetLanguage: target_language,
    targetLanguageCode: lang.code,
    sourceLanguage: source_language ?? null,
    voiceId: voice_id ?? null,
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
  void runDubJob(job, lang, file.buffer, file.originalname || 'source-audio', file.mimetype);

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
    target_language: job.targetLanguageCode,
    source_language: job.sourceLanguage,
    audio_url: job.audioUrl,
    audio_duration_sec: job.audioDurationSec ?? undefined,
    max_start_drift_sec: job.maxDriftSec,
    segments: job.segments,
    dropped_segments: job.dropped,
    voices: job.voices,
    diarization: job.diarization,
    warnings: job.warnings,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
  });
}));

// --------------------------------------------------------------------------
// GET /api/dub/:jobId/subtitles?format=srt|vtt&text=translated|source
// Cues use the DUB timeline for translated text (so they match the audio we return) and the SOURCE timeline
// for source text.
// --------------------------------------------------------------------------
dubRouter.get('/:jobId/subtitles', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { jobId } = req.params;
  if (!jobId) throw new ValidationError('Job ID is required');

  const job = dubJobs.get(jobId);
  if (!job || job.userId !== userId) throw new NotFoundError('Dubbing job');

  const format = String(req.query['format'] ?? 'srt').toLowerCase();
  if (format !== 'srt' && format !== 'vtt') throw new ValidationError('format must be "srt" or "vtt"');
  const which = String(req.query['text'] ?? 'translated').toLowerCase();
  if (which !== 'translated' && which !== 'source') throw new ValidationError('text must be "translated" or "source"');

  if (job.status !== 'ready' || !job.segments) {
    res.status(409).json({ error: `Dubbing job is ${job.status}; subtitles are available once it is ready.` });
    return;
  }

  const cues: Cue[] = job.segments
    .filter((s) => !(which === 'translated' && s.skipped))
    .map((s) =>
      which === 'translated'
        ? { start: s.placed_start_sec, end: s.placed_start_sec + (s.synth_sec > 0 ? s.synth_sec : s.end_sec - s.start_sec), text: s.translated_text }
        : { start: s.start_sec, end: s.end_sec, text: s.source_text }
    );

  const body = format === 'srt' ? toSrt(cues) : toVtt(cues);
  res
    .status(200)
    .type(format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/vtt; charset=utf-8')
    .send(body);
}));
