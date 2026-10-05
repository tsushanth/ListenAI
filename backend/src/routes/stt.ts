// Customer-facing batch speech-to-text: proxy to the external worker-stt-prod Modal app
// (faster-whisper large-v3-turbo, `realtime-stt-worker` in the separate rt-stt-rt-prod repo).
//
// Unlike voiceClone.ts/voiceConvert.ts, worker-stt-prod is NOT called directly with a static
// bearer secret. Per its own README/app.py docstring, it only accepts a short-lived session
// token minted by the realtime-tts gateway's `POST /stt/authorize` (same gateway and hand-off
// contract as web/src/lib/mcp/upstream.ts's authorize() and routes/realtimeTts.ts's /authorize —
// {key, mode:"batch"} in, {token, url} out). So this route authorizes with a single shared,
// backend-owned gateway key (STT_API_KEY) exactly the way realtimeTts.ts uses REALTIME_TTS_API_KEY,
// then POSTs audio straight to `${url}/v1/stt` with that token.
//
// Deploy model: worker-stt-prod is a SHARED, always-callable Modal app that scales to zero on its
// own (min_containers=0, scaledown_window=120s) with a hard concurrency cap (STT_MAX_CONTAINERS=4)
// baked into its own deploy config — see rt-stt-rt-prod/worker-stt-prod/README.md. That already is
// the GPU self-serve cost control the per-user model in voiceConvert.ts exists to provide: nobody
// pays for idle GPU time, and total spend is capped regardless of how many ReadAloudAI users call
// this route. A per-user deploy/teardown pair (mirroring voiceConvert.ts) would mean this backend
// running `modal deploy` once per user against a worker that was built and tested as a single
// multi-tenant service (its own auth is a shared secret-derived session token, not per-app-instance
// secrets) — more moving parts and cold-start latency for zero cost benefit over what the worker
// already does. So: no deploy/teardown endpoints here. See config.ts's STT_GATEWAY_URL/STT_API_KEY
// comment for the corresponding env wiring, and realtimeTtsBilling.ts's reportSttUsage for why
// billing is done explicitly per-call here rather than via the gateway-key usage drain.
//
// API surfaces (all behind requireAuthOrApiKey, all the same authorize-then-worker flow):
//   /api/stt/transcriptions           original multipart API used by the web app and the MCP tool (unchanged contract)
//   POST /v1/listen                   Deepgram prerecorded-shaped REST (raw audio body)
//   POST /v1/audio/transcriptions     OpenAI-shaped REST (multipart `file`)
//   DELETE /v1/transcriptions/:id     delete-my-transcript for the /v1 surface (request_id == row id)
// Hardening (see research/W20/REPORT.md in internal-docs): uploads stream to a temp file with a size cap and are
// type-checked from their magic bytes (client MIME ignored), per-key rate + concurrency limits (lib/sttLimits.ts),
// transcript text is NOT stored unless a retention period is configured for the key, failed requests are unbilled,
// and optional keyterms are forwarded to the worker as repeated `keyterm` query params (worker contract:
// research/W20/REPORT.md section "Upstream worker contract").

import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportSttUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';
import { SttLimiter } from '../lib/sttLimits.js';
import { parseKeyterms } from '../lib/sttKeyterms.js';
import { removeQuiet, sniffFile, streamToFile, sttTmpDir, tmpPath, UploadTooLargeError, workerBody } from '../lib/sttUpload.js';

const log = logger.child({ module: 'stt' });

// --------------------------------------------------------------------------
// Options (config-driven; tests override via createSttRouters)
// --------------------------------------------------------------------------

export interface SttOptions {
  maxUploadBytes: number;
  tmpDir: string;
  ratePerMin: number;
  maxConcurrentPerKey: number;
  maxConcurrentGlobal: number;
  concurrencyRetryAfterSec: number;
  maxKeyterms: number;
  /** Cap on the URL-encoded keyterm query string sent to the worker (query strings, not bodies, carry the terms). */
  keytermsMaxQueryBytes: number;
  defaultRetentionDays: number;
  maxRetentionDays: number;
  /** How long a stt_key_settings lookup is cached per key. 0 disables caching (tests). */
  settingsTtlMs: number;
  workerTimeoutMs: number;
  /** Billing hook (per-second metering). Defaults to reportSttUsage; injectable for tests. */
  reportUsage: (userId: string, audioSeconds: number) => Promise<void>;
}

function defaultOptions(): SttOptions {
  return {
    maxUploadBytes: config.STT_MAX_UPLOAD_MB * 1024 * 1024,
    tmpDir: '',
    ratePerMin: config.STT_RATE_LIMIT_PER_MIN,
    maxConcurrentPerKey: config.STT_MAX_CONCURRENT_PER_KEY,
    maxConcurrentGlobal: config.STT_MAX_CONCURRENT_GLOBAL,
    concurrencyRetryAfterSec: 5,
    maxKeyterms: config.STT_MAX_KEYTERMS,
    keytermsMaxQueryBytes: config.STT_KEYTERMS_MAX_QUERY_BYTES,
    defaultRetentionDays: config.STT_DEFAULT_RETENTION_DAYS,
    maxRetentionDays: config.STT_MAX_RETENTION_DAYS,
    settingsTtlMs: 60_000,
    workerTimeoutMs: 15 * 60_000, // worker enforces its own 900s/request cap; give some slack
    reportUsage: reportSttUsage,
  };
}

// --------------------------------------------------------------------------
// Gateway client
// --------------------------------------------------------------------------

const STT_GATEWAY_URL = config.STT_GATEWAY_URL || 'https://api.readaloudai.org';
const STT_API_KEY = config.STT_API_KEY;
const MODEL_ID = 'whisper-large-v3-turbo';

interface AuthorizeResult { token: string; url: string }

/** Exchange the backend's shared gateway key for a short-lived worker-stt-prod session token + URL. */
async function authorizeStt(): Promise<AuthorizeResult> {
  if (!STT_API_KEY) throw new Error('Speech-to-text is not configured');
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
  if (upstream.status === 501) throw new Error('Speech-to-text is not available (worker not configured upstream)');
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw new Error(`STT authorize failed with HTTP ${upstream.status}: ${text}`);
  }
  const body = (await upstream.json().catch(() => null)) as { token?: string; url?: string } | null;
  if (!body?.token || !body.url) throw new Error('STT authorize returned an unexpected response');
  return { token: body.token, url: body.url };
}

interface WorkerWord { word: string; start: number; end: number; probability?: number }
interface WorkerSegment { id: number; start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }
interface TranscribeResult {
  text: string;
  language: string;
  language_probability?: number;
  duration: number;
  words?: WorkerWord[];
  segments?: WorkerSegment[];
  /** W18 quality signal; opaque passthrough (never interpreted or persisted here). */
  quality?: Record<string, unknown>;
  /** W18 dictionary report (truncation etc.); opaque passthrough. */
  dictionary?: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** POST the audio file (streamed from disk) to worker-stt-prod's /v1/stt, authenticated with a freshly minted session token. */
async function callWorker(opts: {
  file: { path: string; size: number; mime: string };
  language?: string;
  wordTimestamps: boolean;
  keyterms: string[];
  smartFormat: boolean;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<TranscribeResult> {
  const { token, url } = await authorizeStt();
  const qs = new URLSearchParams();
  if (opts.language) qs.set('language', opts.language);
  if (opts.wordTimestamps) qs.set('word_timestamps', 'true');
  if (opts.smartFormat) qs.set('smart_format', 'true');
  for (const t of opts.keyterms) qs.append('keyterm', t);

  const body = workerBody(opts.file.path, opts.file.size, opts.file.mime);
  const res = await fetch(`${url}/v1/stt?${qs.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...body.headers },
    body: body.body,
    duplex: body.duplex,
    signal: AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), opts.signal]),
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`worker-stt-prod returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json.text !== 'string' || typeof json.duration !== 'number' || !Number.isFinite(json.duration) || json.duration < 0) {
    throw new Error('worker-stt-prod returned an unexpected response');
  }
  return {
    text: json.text,
    language: typeof json.language === 'string' ? json.language : 'en',
    language_probability: typeof json.language_probability === 'number' ? json.language_probability : undefined,
    duration: json.duration,
    words: Array.isArray(json.words) ? (json.words as WorkerWord[]) : undefined,
    segments: Array.isArray(json.segments) ? (json.segments as WorkerSegment[]) : undefined,
    quality: isObj(json.quality) ? json.quality : undefined,
    dictionary: isObj(json.dictionary) ? json.dictionary : undefined,
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

type Kind = 'legacy' | 'deepgram' | 'openai';
type AuthedReq = Request & { userId?: string; authMethod?: string };

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** Error body in the shape each surface's clients expect. `rid` is only used by the Deepgram shape. */
function sendErr(res: Response, kind: Kind, status: number, code: string, message: string, rid?: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (kind === 'deepgram') {
    res.status(status).json({ err_code: code.toUpperCase(), err_msg: message, request_id: rid ?? randomUUID() });
  } else if (kind === 'openai') {
    const type = status === 401 ? 'authentication_error' : status === 402 ? 'insufficient_quota' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error';
    res.status(status).json({ error: { message, type, code } });
  } else {
    res.status(status).json({ error: message });
  }
}

/** The thing limits and settings are keyed on: the gateway key id for API-key callers, else the user id. */
function subjectOf(req: AuthedReq, userId: string): string {
  if (req.authMethod === 'gateway-key') {
    const k = String(req.headers['x-gateway-key-id'] ?? '').trim();
    if (k && k.length <= 128) return `key:${k}`;
  }
  return userId;
}

/** Repeatable-field accessor: `name`, `name[]`, or an array value (multer/qs both produce these). */
function vals(src: unknown, name: string): unknown[] {
  if (!isObj(src)) return [];
  const out: unknown[] = [];
  for (const k of [name, `${name}[]`]) {
    const v = src[k];
    if (Array.isArray(v)) out.push(...v); else if (v !== undefined) out.push(v);
  }
  return out;
}
const first = (src: unknown, name: string): string | undefined => {
  const v = vals(src, name)[0];
  return typeof v === 'string' ? v : undefined;
};

class BadParam extends Error { constructor(message: string) { super(message); } }

function parseBool(v: string | undefined, dflt: boolean, name: string): boolean {
  if (v === undefined || v === '') return dflt;
  const l = v.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(l)) return true;
  if (['false', '0', 'no', 'off'].includes(l)) return false;
  throw new BadParam(`${name} must be true or false`);
}

/** Lenient language parsing for the /v1 surfaces: "en-US" -> "en"; "multi"/"auto"/empty -> auto-detect. */
function parseLanguageCompat(v: string | undefined): string | undefined {
  const raw = cleanStr(v, 16).toLowerCase();
  if (!raw || raw === 'auto' || raw === 'multi') return undefined;
  const m = /^([a-z]{2})(?:[-_][a-z0-9]{2,4})?$/.exec(raw);
  if (!m) throw new BadParam(`Unsupported language: ${raw}. Use an ISO-639-1 code such as "en", or "multi" to auto-detect.`);
  return m[1];
}

const PUNCT_TRAIL = /[.,!?;:"()]+$/;
const PUNCT_LEAD = /^[("]+/;
/** Remove sentence punctuation without touching "$42.18" or "555-1234" style tokens. */
function stripPunct(text: string): string {
  return text.replace(/[.,!?;:"()]+(?=\s|$)/g, '').replace(/(^|\s)["(]+/g, '$1').replace(/\s+/g, ' ').trim();
}
const bareWord = (w: string): string => w.trim().replace(PUNCT_TRAIL, '').replace(PUNCT_LEAD, '') || w.trim();

// --------------------------------------------------------------------------
// Response shapes
// --------------------------------------------------------------------------

function deepgramBody(id: string, r: TranscribeResult, punctuate: boolean) {
  const words = (r.words ?? []).map((w) => {
    const punctuated = punctuate ? w.word.trim() : stripPunct(w.word.trim()) || w.word.trim();
    return {
      word: bareWord(w.word),
      start: w.start,
      end: w.end,
      // No fabricated confidence: null when the worker did not provide a probability.
      confidence: typeof w.probability === 'number' ? w.probability : null,
      punctuated_word: punctuated,
    };
  });
  const probs = (r.words ?? []).map((w) => w.probability).filter((p): p is number => typeof p === 'number');
  const confidence = probs.length ? Math.round((probs.reduce((a, b) => a + b, 0) / probs.length) * 10000) / 10000 : null;
  const alt: Record<string, unknown> = {
    transcript: punctuate ? r.text : stripPunct(r.text),
    confidence,
    words,
  };
  const nc = r.quality?.needs_confirmation;
  if (Array.isArray(nc)) alt.needs_confirmation = nc;
  const results: Record<string, unknown> = {
    channels: [{ detected_language: r.language, alternatives: [alt] }],
  };
  if (r.quality) results.quality = r.quality;
  return {
    metadata: {
      request_id: id,
      created: new Date().toISOString(),
      duration: r.duration,
      channels: 1,
      models: [MODEL_ID],
    },
    results,
  };
}

function openaiVerbose(r: TranscribeResult, withWords: boolean) {
  const out: Record<string, unknown> = {
    task: 'transcribe',
    language: r.language,
    duration: r.duration,
    text: r.text,
    segments: (r.segments ?? []).map((s) => ({
      id: s.id, seek: 0, start: s.start, end: s.end, text: s.text, tokens: [], temperature: 0,
      avg_logprob: typeof s.avg_logprob === 'number' ? s.avg_logprob : 0,
      compression_ratio: 0,
      no_speech_prob: typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0,
    })),
  };
  if (withWords) out.words = (r.words ?? []).map((w) => ({ word: bareWord(w.word), start: w.start, end: w.end }));
  if (r.dictionary) out.x_dictionary = r.dictionary;
  if (r.quality) out.x_quality = r.quality;
  return out;
}

// --------------------------------------------------------------------------
// Retention: delete expired rows (transcripts are only ever stored with an expires_at)
// --------------------------------------------------------------------------

/**
 * TTL purge. Rows only carry text when a retention period was set, and then also carry `expires_at`; this deletes
 * every row past it. Run from a scheduler (the migration also installs an equivalent pg_cron job when available).
 */
export async function purgeExpiredSttTranscripts(now: Date = new Date()): Promise<number> {
  const { count, error } = await supabase.from('stt_transcriptions').delete({ count: 'exact' }).lt('expires_at', now.toISOString());
  if (error) throw error;
  return count ?? 0;
}

// --------------------------------------------------------------------------
// Router factory
// --------------------------------------------------------------------------

interface KeySettings { retention_days?: number | null; rate_per_min?: number | null; max_concurrent?: number | null }

interface Ctx {
  userId: string;
  subject: string;
  settings: KeySettings;
  rid: string;
  file?: { path: string; size: number; mime: string };
  release: () => void;
  /** Delete the temp file and release the concurrency slot (idempotent). Always called before replying. */
  done: () => Promise<void>;
  abort: AbortController;
}
type CtxReq = AuthedReq & { stt?: Ctx };

export function createSttRouters(overrides: Partial<SttOptions> = {}): { sttRouter: Router; sttCompatRouter: Router } {
  const opts: SttOptions = { ...defaultOptions(), ...overrides };
  const tmpDir = sttTmpDir(opts.tmpDir || config.STT_TMP_DIR);
  const limiter = new SttLimiter({
    ratePerMin: opts.ratePerMin,
    maxConcurrentPerKey: opts.maxConcurrentPerKey,
    maxConcurrentGlobal: opts.maxConcurrentGlobal,
    concurrencyRetryAfterSec: opts.concurrencyRetryAfterSec,
  });
  const settingsCache = new Map<string, { at: number; val: KeySettings }>();

  async function loadSettings(subject: string): Promise<KeySettings> {
    const hit = settingsCache.get(subject);
    if (hit && Date.now() - hit.at < opts.settingsTtlMs) return hit.val;
    let val: KeySettings = {};
    try {
      const { data, error } = await supabase.from('stt_key_settings').select('retention_days, rate_per_min, max_concurrent').eq('subject', subject).maybeSingle();
      if (error) throw error;
      val = (data as KeySettings | null) ?? {};
    } catch (err) {
      // Fail to the defaults, which are the most protective: zero retention and the standard limits.
      log.warn({ err }, 'stt_key_settings lookup failed; using defaults');
    }
    if (opts.settingsTtlMs > 0) settingsCache.set(subject, { at: Date.now(), val });
    return val;
  }

  /** Identity only (no billing gate): used for GET/DELETE so a user can always delete their own data. */
  async function identify(req: AuthedReq): Promise<{ userId: string } | { status: number; message: string }> {
    if (req.userId) return { userId: req.userId };
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return { status: 401, message: 'Sign in required.' };
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { status: 401, message: 'Invalid token.' };
    req.userId = user.id;
    return { userId: user.id };
  }

  // The identity is normally resolved by requireAuthOrApiKey (index.ts mounts both routers behind it); the inline
  // JWT fallback keeps the routers working standalone (tests). The subscription/free-credit gate applies either way.
  const identityOnly = (kind: Kind) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const who = await identify(req as AuthedReq);
      if ('status' in who) { sendErr(res, kind, who.status, 'unauthorized', who.message); return; }
      next();
    } catch (e) { next(e); }
  };

  /**
   * auth -> billing gate (402) -> per-key rate limit (429) -> per-key/global concurrency cap (429).
   * On success `req.stt` holds the request context; every later exit path must call `ctx.done()`.
   */
  const gate = (kind: Kind) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = req as CtxReq;
      const who = await identify(r);
      if ('status' in who) { sendErr(res, kind, who.status, 'unauthorized', who.message); return; }
      const userId = who.userId;
      if (!(await hasUsageAllowance(userId))) { sendErr(res, kind, 402, 'insufficient_credits', freeCreditsExhaustedMessage('speech-to-text')); return; }

      const subject = subjectOf(r, userId);
      const settings = await loadSettings(subject);
      const ov = { ratePerMin: settings.rate_per_min, maxConcurrent: settings.max_concurrent };

      const rate = limiter.checkRate(subject, ov);
      if (!rate.ok) {
        sendErr(res, kind, 429, 'rate_limited', 'Too many requests. Slow down and retry after the indicated time.', undefined, { 'Retry-After': String(rate.retryAfterSec) });
        return;
      }
      const slot = limiter.acquire(subject, ov);
      if (!slot.ok) {
        sendErr(res, kind, 429, 'concurrency_limited', 'Too many transcriptions in progress for this key. Retry shortly.', undefined, { 'Retry-After': String(slot.retryAfterSec) });
        return;
      }

      const ctx: Ctx = {
        userId, subject, settings, rid: randomUUID(), release: slot.release, abort: new AbortController(),
        done: async () => { slot.release(); await removeQuiet(ctx.file?.path); },
      };
      r.stt = ctx;
      res.on('close', () => {
        if (!res.writableFinished) ctx.abort.abort(); // client went away: cancel the worker call, never bill
        void ctx.done();
      });
      next();
    } catch (e) { next(e); }
  };

  // ---- ingestion ----------------------------------------------------------

  const multerUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, tmpDir),
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: opts.maxUploadBytes, files: 1, fields: 80, fieldSize: 1024 * 1024, parts: 90 },
  });

  /** multipart ingest: the file part goes straight to a temp file (never memory). */
  const ingestMultipart = (kind: Kind, field: string) => (req: Request, res: Response, next: NextFunction) => {
    const ctx = (req as CtxReq).stt!;
    multerUpload.single(field)(req, res, (err: unknown) => {
      // Whatever multer wrote is tracked on req.file even when later validation fails.
      if (req.file) ctx.file = { path: req.file.path, size: req.file.size, mime: '' };
      if (err) {
        void ctx.done();
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') { sendErr(res, kind, 413, 'payload_too_large', `File too large (max ${Math.floor(opts.maxUploadBytes / 1048576)} MB).`, ctx.rid); return; }
          sendErr(res, kind, 400, 'malformed_multipart', err.message, ctx.rid);
          return;
        }
        sendErr(res, kind, 400, 'malformed_multipart', 'Malformed multipart body.', ctx.rid);
        return;
      }
      next();
    });
  };

  /** raw-body ingest (Deepgram style): stream the request into a temp file with a hard byte cap. */
  const ingestRaw = (kind: Kind) => async (req: Request, res: Response, next: NextFunction) => {
    const ctx = (req as CtxReq).stt!;
    try {
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase();
      if (ctype.startsWith('application/json')) {
        await ctx.done();
        sendErr(res, kind, 400, 'url_input_unsupported', 'JSON {"url": ...} bodies are not supported; send the audio bytes as the request body.', ctx.rid);
        return;
      }
      if (ctype.startsWith('multipart/')) {
        await ctx.done();
        sendErr(res, kind, 400, 'bad_content_type', 'Send the raw audio bytes as the body (use /v1/audio/transcriptions for multipart).', ctx.rid);
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxUploadBytes) {
        await ctx.done();
        res.setHeader('Connection', 'close');
        sendErr(res, kind, 413, 'payload_too_large', `File too large (max ${Math.floor(opts.maxUploadBytes / 1048576)} MB).`, ctx.rid);
        return;
      }
      const p = tmpPath(tmpDir);
      ctx.file = { path: p, size: 0, mime: '' };
      try {
        ctx.file.size = await streamToFile(req, p, opts.maxUploadBytes);
      } catch (err) {
        await ctx.done();
        if (err instanceof UploadTooLargeError) {
          res.setHeader('Connection', 'close');
          sendErr(res, kind, 413, 'payload_too_large', `File too large (max ${Math.floor(opts.maxUploadBytes / 1048576)} MB).`, ctx.rid);
        } else if (!res.headersSent && !res.writableEnded && !req.destroyed) {
          sendErr(res, kind, 400, 'malformed_body', 'Could not read the request body.', ctx.rid);
        }
        return;
      }
      next();
    } catch (e) { await (req as CtxReq).stt?.done(); next(e); }
  };

  /** Validates the stored upload: non-empty and a recognised audio container (client MIME ignored). */
  async function validateFile(kind: Kind, req: Request, res: Response, missingMsg: string): Promise<boolean> {
    const ctx = (req as CtxReq).stt!;
    if (!ctx.file || ctx.file.size < 64) {
      await ctx.done();
      sendErr(res, kind, 400, 'missing_audio', missingMsg, ctx.rid);
      return false;
    }
    const sniffed = await sniffFile(ctx.file.path);
    if (!sniffed) {
      await ctx.done();
      sendErr(res, kind, 400, 'unsupported_audio', 'Unsupported audio format (detected from file contents). Allowed: WAV, FLAC, OGG, MP3, M4A, WEBM.', ctx.rid);
      return false;
    }
    ctx.file.mime = sniffed.mime;
    return true;
  }

  /** Parse the shared keyterms/dictionary params; responds 400 and returns null when invalid. */
  function readKeyterms(kind: Kind, res: Response, ctx: Ctx, sources: unknown[][]): string[] | null {
    const r = parseKeyterms(sources.flat(), { maxTerms: opts.maxKeyterms });
    if ('error' in r) { void ctx.done(); sendErr(res, kind, 400, 'bad_param', r.error, ctx.rid); return null; }
    const q = new URLSearchParams();
    for (const t of r.terms) q.append('keyterm', t);
    if (Buffer.byteLength(q.toString()) > opts.keytermsMaxQueryBytes) {
      void ctx.done();
      sendErr(res, kind, 400, 'bad_param', `Keyterms are too long in total (max ${opts.keytermsMaxQueryBytes} bytes encoded). Send fewer or shorter terms.`, ctx.rid);
      return null;
    }
    return r.terms;
  }

  // ---- core flow ------------------------------------------------------------

  type Outcome =
    | { ok: true; id: string; result: TranscribeResult }
    | { ok: false; id?: string; status: number; code: string; message: string };

  /**
   * Insert a metadata row, call the worker, finish the row, bill on success only. Transcript text/words/segments
   * are written to the row ONLY when the key has a retention period (then with an expires_at); the default is
   * metadata only. A failed request is never billed.
   */
  async function runTranscription(ctx: Ctx, p: {
    surface: string; language?: string; wordTimestamps: boolean; keyterms: string[]; smartFormat: boolean; mimeSniffed: string; size: number;
  }): Promise<Outcome> {
    const retentionDays = Math.max(0, Math.min(Number(ctx.settings.retention_days ?? opts.defaultRetentionDays) || 0, opts.maxRetentionDays));
    const { data: row, error: insertErr } = await supabase
      .from('stt_transcriptions')
      .insert({
        user_id: ctx.userId,
        language_requested: p.language ?? null,
        word_timestamps: p.wordTimestamps,
        input_bytes: p.size,
        input_mimetype: p.mimeSniffed,
        status: 'processing',
        surface: p.surface,
        keyterm_count: p.keyterms.length,
        retention_days: retentionDays,
      })
      .select('id')
      .single();
    if (insertErr) throw insertErr;
    const id = row.id as string;

    try {
      const result = await callWorker({
        file: ctx.file!, language: p.language, wordTimestamps: p.wordTimestamps, keyterms: p.keyterms, smartFormat: p.smartFormat,
        signal: ctx.abort.signal, timeoutMs: opts.workerTimeoutMs,
      });
      const completedAt = new Date();
      const update: Record<string, unknown> = {
        status: 'done',
        language_detected: result.language,
        language_probability: result.language_probability ?? null,
        duration_seconds: result.duration,
        completed_at: completedAt.toISOString(),
      };
      if (retentionDays > 0) {
        update.text = result.text;
        update.words = result.words ?? null;
        update.segments = result.segments ?? null;
        update.expires_at = new Date(completedAt.getTime() + retentionDays * 86_400_000).toISOString();
      }
      const { error: updErr } = await supabase.from('stt_transcriptions').update(update).eq('id', id);
      if (updErr) log.warn({ err: updErr, id }, 'STT row update failed (non-critical)');

      opts.reportUsage(ctx.userId, result.duration).catch((err: unknown) =>
        log.warn({ err, userId: ctx.userId, id, duration: result.duration }, 'STT billing report failed (non-critical)'));
      return { ok: true, id, result };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.from('stt_transcriptions').update({ status: 'failed', error: message.slice(0, 500), completed_at: new Date().toISOString() }).eq('id', id);
      log.error({ err, userId: ctx.userId, id }, 'STT transcription failed');
      return { ok: false, id, status: 502, code: 'upstream_failed', message: 'Transcription failed. Please try again.' };
    }
  }

  async function deleteHandler(kind: Kind, req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as AuthedReq).userId!;
      const { error, count } = await supabase.from('stt_transcriptions').delete({ count: 'exact' }).eq('id', req.params.id).eq('user_id', userId);
      if (error) throw error;
      if (!count) { sendErr(res, kind, 404, 'not_found', 'Transcription not found.'); return; }
      res.json({ deleted: true });
    } catch (e) { next(e); }
  }

  const errorHandler = (kind: Kind) => (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    void (req as CtxReq).stt?.done();
    log.error({ err }, 'stt error');
    sendErr(res, kind, 500, 'internal_error', 'Something went wrong.');
  };

  // Dark by default, same posture as voiceClone.ts/voiceConvert.ts.
  const dark = (_req: Request, res: Response, next: NextFunction) => {
    if (!STT_API_KEY) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  };

  // ==========================================================================
  // Original API: /api/stt/transcriptions (contract unchanged; additions are optional)
  // ==========================================================================
  const legacy = Router();
  legacy.use(dark);

  const SUPPORTED_LANG_HINT = /^[a-z]{2}$/; // ISO-639-1; omitted = auto-detect

  legacy.post('/transcriptions', gate('legacy'), ingestMultipart('legacy', 'audio'), async (req, res, next) => {
    const ctx = (req as CtxReq).stt!;
    try {
      if (!(await validateFile('legacy', req, res, 'Audio file is required.'))) return;
      const languageRaw = cleanStr(req.body?.language, 10);
      const language = languageRaw && SUPPORTED_LANG_HINT.test(languageRaw) ? languageRaw : undefined;
      if (languageRaw && !language) {
        await ctx.done();
        sendErr(res, 'legacy', 400, 'bad_param', `Unsupported language hint: ${languageRaw}. Use an ISO-639-1 code (e.g. "en") or omit for auto-detect.`);
        return;
      }
      const wordTimestamps = req.body?.word_timestamps === 'true' || req.body?.word_timestamps === true;
      const keyterms = readKeyterms('legacy', res, ctx, [vals(req.body, 'keyterm'), vals(req.body, 'keyterms'), vals(req.body, 'dictionary')]);
      if (!keyterms) return;

      const out = await runTranscription(ctx, { surface: 'api', language, wordTimestamps, keyterms, smartFormat: false, mimeSniffed: ctx.file!.mime, size: ctx.file!.size });
      await ctx.done();
      if (!out.ok) { res.status(out.status).json({ id: out.id, status: 'failed', error: out.message }); return; }
      const r = out.result;
      res.status(201).json({
        id: out.id,
        status: 'done',
        text: r.text,
        language: r.language,
        language_probability: r.language_probability ?? null,
        duration: r.duration,
        words: r.words ?? undefined,
        segments: r.segments ?? undefined,
        quality: r.quality,
        dictionary: r.dictionary,
      });
    } catch (e) { next(e); }
  });

  legacy.get('/transcriptions', identityOnly('legacy'), async (req, res, next) => {
    try {
      const userId = (req as AuthedReq).userId!;
      const { data, error } = await supabase
        .from('stt_transcriptions')
        .select('id, status, language_requested, language_detected, duration_seconds, created_at, completed_at, retention_days, expires_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      res.json({ transcriptions: data ?? [] });
    } catch (e) { next(e); }
  });

  // Status + result. With the default zero-retention policy a finished row has metadata only (no `text`).
  legacy.get('/transcriptions/:id', identityOnly('legacy'), async (req, res, next) => {
    try {
      const userId = (req as AuthedReq).userId!;
      const { data, error } = await supabase.from('stt_transcriptions').select('*').eq('id', req.params.id).eq('user_id', userId).maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Transcription not found.' }); return; }
      res.json(data);
    } catch (e) { next(e); }
  });

  // Delete-my-transcript. Deliberately NOT behind the billing gate: a user must always be able to delete their data.
  legacy.delete('/transcriptions/:id', identityOnly('legacy'), (req, res, next) => { void deleteHandler('legacy', req, res, next); });

  legacy.use(errorHandler('legacy'));

  // ==========================================================================
  // /v1 compat surface: Deepgram prerecorded + OpenAI transcriptions
  // ==========================================================================
  const compat = Router();
  compat.use(dark);

  compat.post('/listen', gate('deepgram'), ingestRaw('deepgram'), async (req, res, next) => {
    const ctx = (req as CtxReq).stt!;
    try {
      if (!(await validateFile('deepgram', req, res, 'Audio body is required.'))) return;
      let language: string | undefined; let punctuate: boolean; let smartFormat: boolean;
      try {
        if (first(req.query, 'callback')) throw new BadParam('callback is not supported (synchronous only).');
        language = parseBool(first(req.query, 'detect_language'), false, 'detect_language') ? undefined : parseLanguageCompat(first(req.query, 'language'));
        punctuate = parseBool(first(req.query, 'punctuate'), true, 'punctuate');
        smartFormat = parseBool(first(req.query, 'smart_format'), false, 'smart_format');
        // Accepted and ignored for now (no diarization / utterance segmentation): validated so typos still 400.
        parseBool(first(req.query, 'diarize'), false, 'diarize');
        parseBool(first(req.query, 'utterances'), false, 'utterances');
        parseBool(first(req.query, 'numerals'), false, 'numerals');
      } catch (e) {
        if (!(e instanceof BadParam)) throw e;
        await ctx.done();
        const code = e.message.startsWith('callback') ? 'callback_unsupported' : 'bad_param';
        sendErr(res, 'deepgram', 400, code, e.message, ctx.rid);
        return;
      }
      // Legacy Deepgram `keywords=Term:boost` is accepted as plain terms.
      const legacyKeywords = vals(req.query, 'keywords').map((k) => (typeof k === 'string' ? k.replace(/:-?\d+(\.\d+)?$/, '') : k));
      const keyterms = readKeyterms('deepgram', res, ctx, [vals(req.query, 'keyterm'), legacyKeywords]);
      if (!keyterms) return;

      const out = await runTranscription(ctx, { surface: 'listen', language, wordTimestamps: true, keyterms, smartFormat, mimeSniffed: ctx.file!.mime, size: ctx.file!.size });
      await ctx.done();
      if (!out.ok) { sendErr(res, 'deepgram', out.status, out.code, out.message, out.id); return; }
      res.setHeader('X-Request-Id', out.id);
      res.json(deepgramBody(out.id, out.result, punctuate));
    } catch (e) { next(e); }
  });

  compat.post('/audio/transcriptions', gate('openai'), ingestMultipart('openai', 'file'), async (req, res, next) => {
    const ctx = (req as CtxReq).stt!;
    try {
      if (!(await validateFile('openai', req, res, 'A `file` part with the audio is required.'))) return;
      const format = (first(req.body, 'response_format') ?? 'json').toLowerCase();
      if (!['json', 'verbose_json', 'text'].includes(format)) {
        await ctx.done();
        sendErr(res, 'openai', 400, 'unsupported_response_format', 'response_format must be json, verbose_json or text.', ctx.rid);
        return;
      }
      let language: string | undefined;
      try { language = parseLanguageCompat(first(req.body, 'language')); } catch (e) {
        if (!(e instanceof BadParam)) throw e;
        await ctx.done();
        sendErr(res, 'openai', 400, 'bad_param', e.message, ctx.rid);
        return;
      }
      const gran = vals(req.body, 'timestamp_granularities').filter((g): g is string => typeof g === 'string');
      const withWords = format === 'verbose_json' && gran.includes('word');
      // `prompt`, `temperature` and any Deepgram-only knobs are accepted and ignored.
      const keyterms = readKeyterms('openai', res, ctx, [vals(req.body, 'keyterm'), vals(req.body, 'keyterms'), vals(req.body, 'dictionary')]);
      if (!keyterms) return;

      const out = await runTranscription(ctx, { surface: 'audio_transcriptions', language, wordTimestamps: withWords, keyterms, smartFormat: false, mimeSniffed: ctx.file!.mime, size: ctx.file!.size });
      await ctx.done();
      if (!out.ok) { sendErr(res, 'openai', out.status, out.code, out.message); return; }
      res.setHeader('X-Request-Id', out.id);
      if (format === 'text') { res.type('text/plain').send(`${out.result.text}\n`); return; }
      if (format === 'json') { res.json({ text: out.result.text }); return; }
      res.json(openaiVerbose(out.result, withWords));
    } catch (e) { next(e); }
  });

  compat.delete('/transcriptions/:id', identityOnly('deepgram'), (req, res, next) => { void deleteHandler('deepgram', req, res, next); });

  // Multer/other errors on the openai route are handled inline; this catches the rest. Shape chosen by path.
  compat.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    errorHandler(req.path.startsWith('/audio/') ? 'openai' : 'deepgram')(err, req, res, next);
  });

  return { sttRouter: legacy, sttCompatRouter: compat };
}

export const { sttRouter, sttCompatRouter } = createSttRouters();
