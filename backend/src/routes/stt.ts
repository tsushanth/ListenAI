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
import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportSttUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'stt' });

// --------------------------------------------------------------------------
// Gateway client
// --------------------------------------------------------------------------

const STT_GATEWAY_URL = config.STT_GATEWAY_URL || 'https://api.readaloudai.org';
const STT_API_KEY = config.STT_API_KEY;

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

interface TranscribeResult {
  text: string;
  language: string;
  language_probability?: number;
  duration: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

/** POST the raw audio bytes to worker-stt-prod's /v1/stt, authenticated with a freshly minted session token. */
async function callWorker(opts: {
  buffer: Buffer;
  mimetype: string;
  language?: string;
  wordTimestamps: boolean;
}): Promise<TranscribeResult> {
  const { token, url } = await authorizeStt();
  const qs = new URLSearchParams();
  if (opts.language) qs.set('language', opts.language);
  if (opts.wordTimestamps) qs.set('word_timestamps', 'true');

  const res = await fetch(`${url}/v1/stt?${qs.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': opts.mimetype || 'application/octet-stream' },
    body: new Uint8Array(opts.buffer),
    signal: AbortSignal.timeout(15 * 60_000), // worker enforces its own 900s/request cap; give some slack
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`worker-stt-prod returned HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<TranscribeResult>;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// backend/src/index.ts now mounts this router behind requireAuthOrApiKey
// (middleware/apiKeyAuth.ts), which resolves either a real Supabase JWT or a
// gateway-forwarded API-key identity and sets req.userId before this router
// ever runs. The `cached` read below is what makes that resolution take effect
// here with zero other changes to this file: requireUser() already preferred
// req.userId over its own JWT check, so requireAuthOrApiKey's identity just
// short-circuits it. The inline JWT fallback stays so this route still works
// standalone (e.g. in tests) if ever mounted without the middleware.
//
// Billing note (still accurate after this change): even if a caller reaches
// this route via the gateway-forwarded-identity branch, isBillingActiveForUser
// below is checked against *that resolved user's* realtimetts_billing row, and
// reportSttUsage (see realtimeTtsBilling.ts) bills that same real user's
// Stripe subscription. STT_API_KEY (used inside authorizeStt() above to talk
// to the gateway/worker) is a separate, house-owned key with no
// realtimetts_billing row of its own — its own gateway-side usage drain is
// intentionally dropped by reportUsageToStripe's "no owning user record"
// branch, so it is never double-billed against a real customer. That analysis
// does not depend on which auth branch resolved req.userId, so it is
// unaffected by this middleware change.
async function requireUser(req: Request, res: Response): Promise<string | null> {
  const cached = (req as Request & { userId?: string }).userId;
  if (cached) {
    // Identity already resolved by requireAuthOrApiKey: the subscription gate must still apply.
    if (!(await hasUsageAllowance(cached))) { res.status(402).json({ error: freeCreditsExhaustedMessage('speech-to-text') }); return null; }
    return cached;
  }

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }

  const active = await hasUsageAllowance(user.id);
  if (!active) { res.status(402).json({ error: freeCreditsExhaustedMessage('speech-to-text') }); return null; }

  (req as Request & { userId?: string }).userId = user.id;
  return user.id;
}

async function requireUserMiddleware(req: Request, res: Response, next: NextFunction) {
  if (await requireUser(req, res)) next();
}

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// --------------------------------------------------------------------------
// File upload — mirrors worker-stt-prod's own limits (200 MB, 3h audio, 900s/request,
// all re-enforced by the worker itself; our multer limit is just a fast local rejection).
// --------------------------------------------------------------------------

const MAX_AUDIO_MB = 200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => { cb(null, true); },
});

const SUPPORTED_LANG_HINT = /^[a-z]{2}$/; // ISO-639-1; worker also accepts omitted = auto-detect

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const sttRouter: Router = (() => {
  const r = Router();

  // Dark by default, same posture as voiceClone.ts/voiceConvert.ts.
  r.use((_req, res, next) => {
    if (!STT_API_KEY) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  });

  const transcribeLimiter = rateLimit({
    windowMs: 3600_000,
    max: 20, // 20 transcriptions/hour per user
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `stt:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can submit 20 transcriptions per hour.' },
  });

  // ------------------------------------------------------------------------
  // POST /transcriptions — submit audio for transcription.
  // worker-stt-prod itself is synchronous (no job queue), so this call blocks until the
  // transcript is ready and returns 201 with the full result — but we still persist a
  // 'processing' row before calling out and flip it to 'done'/'failed' after, so the
  // status/result read path below behaves the same way voiceConvert.ts's async jobs do.
  // ------------------------------------------------------------------------
  r.post('/transcriptions', requireUserMiddleware, transcribeLimiter, upload.single('audio'), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const file = req.file;
      if (!file || file.size < 64) {
        res.status(400).json({ error: 'Audio file is required.' });
        return;
      }

      const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mp3', 'audio/webm'];
      if (!allowedMimes.includes(file.mimetype)) {
        res.status(400).json({ error: `Unsupported audio format: ${file.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A, WEBM.` });
        return;
      }

      const languageRaw = cleanStr(req.body?.language, 10);
      const language = languageRaw && SUPPORTED_LANG_HINT.test(languageRaw) ? languageRaw : undefined;
      if (languageRaw && !language) {
        res.status(400).json({ error: `Unsupported language hint: ${languageRaw}. Use an ISO-639-1 code (e.g. "en") or omit for auto-detect.` });
        return;
      }
      const wordTimestamps = req.body?.word_timestamps === 'true' || req.body?.word_timestamps === true;

      const { data: row, error: insertErr } = await supabase
        .from('stt_transcriptions')
        .insert({
          user_id: userId,
          language_requested: language ?? null,
          word_timestamps: wordTimestamps,
          input_bytes: file.size,
          input_mimetype: file.mimetype,
          status: 'processing',
        })
        .select('id')
        .single();
      if (insertErr) throw insertErr;
      const id = row.id as string;

      try {
        const result = await callWorker({
          buffer: file.buffer,
          mimetype: file.mimetype,
          language,
          wordTimestamps,
        });

        await supabase.from('stt_transcriptions').update({
          status: 'done',
          text: result.text,
          language_detected: result.language,
          language_probability: result.language_probability ?? null,
          duration_seconds: result.duration,
          words: result.words ?? null,
          segments: result.segments ?? null,
          completed_at: new Date().toISOString(),
        }).eq('id', id);

        reportSttUsage(userId, result.duration).catch((err: unknown) =>
          log.warn({ err, userId, id, duration: result.duration }, 'STT billing report failed (non-critical)')
        );

        res.status(201).json({
          id,
          status: 'done',
          text: result.text,
          language: result.language,
          language_probability: result.language_probability ?? null,
          duration: result.duration,
          words: result.words ?? undefined,
          segments: result.segments ?? undefined,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await supabase.from('stt_transcriptions').update({
          status: 'failed',
          error: message,
          completed_at: new Date().toISOString(),
        }).eq('id', id);
        log.error({ err, userId, id }, 'STT transcription failed');
        res.status(502).json({ id, status: 'failed', error: 'Transcription failed. Please try again.' });
      }
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // GET /transcriptions — list this user's transcriptions
  // ------------------------------------------------------------------------
  r.get('/transcriptions', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('stt_transcriptions')
        .select('id, status, language_requested, language_detected, duration_seconds, created_at, completed_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      res.json({ transcriptions: data ?? [] });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // GET /transcriptions/:id — status + result (status/result are the same read since the
  // upstream call is synchronous; a 'processing' row can only be observed mid-request).
  // ------------------------------------------------------------------------
  r.get('/transcriptions/:id', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('stt_transcriptions')
        .select('*')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Transcription not found.' }); return; }
      res.json(data);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // DELETE /transcriptions/:id — delete a stored transcript (no upstream state to clean up;
  // worker-stt-prod never persists audio or results after responding).
  // ------------------------------------------------------------------------
  r.delete('/transcriptions/:id', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { error, count } = await supabase
        .from('stt_transcriptions')
        .delete({ count: 'exact' })
        .eq('id', req.params.id)
        .eq('user_id', userId);
      if (error) throw error;
      if (!count) { res.status(404).json({ error: 'Transcription not found.' }); return; }
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  // Error handler
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File too large (max ${MAX_AUDIO_MB} MB).` });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    log.error({ err }, 'stt error');
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return r;
})();
