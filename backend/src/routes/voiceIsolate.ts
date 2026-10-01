// Vocal isolation (Demucs htdemucs): self-serve per-user Modal deployments.
// The backend deploys a Modal Demucs app on behalf of each user (with their own GPU container)
// and tears it down when requested.  This keeps audio off our servers and gives users cost control.
// Mirrors voiceConvert.ts's pattern exactly - see that file for the fuller rationale comments.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { getDeploymentManager, type DeployTarget } from '../lib/modalDeployments.js';
import { recordModalUsage } from '../lib/modalUsage.js';
import { mountDeploymentRoutes } from './deployments.js';
import { supabase } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportVoiceIsolateUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceIsolate' });


// --------------------------------------------------------------------------
// Per-user deployment: where this user's jobs go (lifecycle lives in lib/modalDeployments.ts)
// --------------------------------------------------------------------------

interface ModalCfg {
  modal_url: string;
  modal_secret: string;
  target: DeployTarget;
}

/** The user's ready deployment, or null (none, still deploying, idle- or age-expired, torn down). No shared fallback worker. */
async function getUserModalConfig(userId: string, forNewWork = false): Promise<ModalCfg | null> {
  const target = await getDeploymentManager().resolveTarget(userId, 'isolate', { forNewWork });
  return target ? { modal_url: target.url, modal_secret: target.secret, target } : null;
}

/** Any job call is activity: restarts the idle clock so a deployment someone is using is not reaped. */
async function touch(cfg: ModalCfg, opts: { job?: boolean } = {}): Promise<void> {
  try {
    await getDeploymentManager().touch(cfg.target, opts);
  } catch (err) {
    log.warn({ err }, 'failed to record deployment activity (non-critical)');
  }
}

function authHeaders(secret: string) {
  return { Authorization: secret ? `Bearer ${secret}` : '' };
}

async function modalRequest<T>(
  cfg: { modal_url: string; modal_secret: string },
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${cfg.modal_url}${path}`;
  const res = await fetch(url, { ...init, headers: { ...authHeaders(cfg.modal_secret), ...(init.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-isolate returned HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

async function modalAudio(cfg: { modal_url: string; modal_secret: string }, path: string): Promise<Buffer> {
  const res = await fetch(`${cfg.modal_url}${path}`, { headers: authHeaders(cfg.modal_secret) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-isolate returned HTTP ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Who is calling, WITHOUT the billing check. Deployment management (status and teardown) uses this: a user whose
 * credits ran out or whose subscription lapsed must still be able to see and tear down their own deployment, since it
 * runs on our Modal bill until it is stopped. The payment requirement for starting one is enforced by the manager.
 */
async function resolveIdentity(req: Request, res: Response): Promise<string | null> {
  const cached = (req as Request & { userId?: string }).userId;
  if (cached) return cached; // already resolved by requireAuthOrApiKey

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }

  (req as Request & { userId?: string }).userId = user.id;
  return user.id;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await resolveIdentity(req, res);
  if (!userId) return null;
  // The subscription gate applies to every resolved identity, including one already set by requireAuthOrApiKey.
  if (!(await hasUsageAllowance(userId))) { res.status(402).json({ error: freeCreditsExhaustedMessage('voice isolation') }); return null; }
  return userId;
}

async function requireUserMiddleware(req: Request, res: Response, next: NextFunction) {
  if (await requireUser(req, res)) next();
}

async function requireIdentityMiddleware(req: Request, res: Response, next: NextFunction) {
  if (await resolveIdentity(req, res)) next();
}

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// --------------------------------------------------------------------------
// File upload limits
// --------------------------------------------------------------------------

const MAX_AUDIO_MB = 50;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => {
    cb(null, true);
  },
});

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const voiceIsolateRouter: Router = (() => {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 3600_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice-isolate:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can isolate 10 clips per hour.' },
  });

  // ------------------------------------------------------------------------
  // Deployment management
  // ------------------------------------------------------------------------

  // Identity only: see resolveIdentity().
  mountDeploymentRoutes(r, 'isolate', requireIdentityMiddleware);

  // ------------------------------------------------------------------------
  // Isolation jobs
  // ------------------------------------------------------------------------

  // Submit an isolation job
  r.post('/isolations', requireUserMiddleware, limiter, upload.fields([
    { name: 'input', maxCount: 1 },
  ]), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const modalCfg = await getUserModalConfig(userId, true); // new work: refused in the last minutes of a deployment's life
      if (!modalCfg) {
        res.status(400).json({ error: 'Voice isolation is not configured. Deploy an isolator first.' });
        return;
      }

      const files = req.files as Record<string, Express.Multer.File[]>;
      const inputFile = files?.input?.[0];

      if (!inputFile) {
        res.status(400).json({ error: 'An input audio file is required.' });
        return;
      }

      const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'];
      if (!allowedMimes.includes(inputFile.mimetype)) {
        res.status(400).json({ error: `Unsupported input format: ${inputFile.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }

      const consent = cleanStr(req.body?.consent_statement, 500);
      const expectedConsent =
        'I confirm that I have the legal right to use this audio and that isolating its vocal ' +
        'track does not infringe anyone else\'s rights.';
      if (consent !== expectedConsent) {
        res.status(400).json({ error: 'consent_statement must echo the exact consent text.' });
        return;
      }

      const wantInstrumental = req.body?.want_instrumental === 'true' || req.body?.want_instrumental === true;

      const formData = new FormData();
      formData.append('input', new Blob([new Uint8Array(inputFile.buffer)]), inputFile.originalname || 'input.wav');

      const modalRes = await fetch(`${modalCfg.modal_url}/isolate?want_instrumental=${wantInstrumental}`, {
        method: 'POST',
        headers: authHeaders(modalCfg.modal_secret),
        body: formData,
      });

      if (!modalRes.ok) {
        const text = await modalRes.text().catch(() => '');
        throw new Error(`Modal returned HTTP ${modalRes.status}: ${text}`);
      }

      const result = await modalRes.json() as { job_id: string; status: string; input_seconds?: number };

      const { error: dbError } = await supabase.from('voice_isolations').insert({
        user_id: userId,
        modal_job_id: result.job_id,
        input_seconds: result.input_seconds ?? null,
        want_instrumental: wantInstrumental,
        status: result.status === 'rejected' ? 'rejected' : 'queued',
      });
      if (dbError) log.warn({ dbError }, 'Failed to insert voice_isolations row (non-critical)');

      // Count the job and restart the deployment's idle clock
      await touch(modalCfg, { job: true });
      const statusCode = result.status === 'rejected' ? 400 : 202;
      res.status(statusCode).json({ job_id: result.job_id, status: result.status });
    } catch (e) { next(e); }
  });

  // Poll an isolation job
  r.get('/isolations/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice isolation is not configured.' }); return; }
      await touch(modalCfg);

      const st = await modalRequest<{ status: string; [key: string]: unknown }>(modalCfg, `/isolate/${req.params.id}`);

      if (st.status === 'done' || st.status === 'failed') {
        // Shadow mode: record the GPU seconds the worker measured for this job (done or failed, both used the GPU).
        // Idempotent per job, so re-polling a finished job does not count it twice. Not billed; see lib/modalUsage.ts.
        if (typeof st.gpu_seconds === 'number') {
          await recordModalUsage({ deploymentId: modalCfg.target.deploymentId, userId, service: 'isolate', jobId: req.params.id, gpuSeconds: st.gpu_seconds });
        }
        // Read the row first so a client re-polling an already-completed job is not billed again
        // (the meter event's identifier also dedupes within Stripe's window, this covers beyond it).
        const { data: prior } = await supabase.from('voice_isolations')
          .select('status, input_seconds')
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId)
          .maybeSingle();
        await supabase.from('voice_isolations')
          .update({ status: st.status, completed_at: new Date().toISOString(), error: (st as any).stderr_tail || null })
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId);
        if (st.status === 'done' && prior?.status !== 'done') {
          // Billed per second of input audio (rounded up, with a minimum), see AUDIO_JOB_PRICING.
          const inputSeconds = typeof st.input_seconds === 'number' ? st.input_seconds : (prior?.input_seconds as number | null | undefined);
          reportVoiceIsolateUsage(userId, inputSeconds, req.params.id).catch((err: unknown) => log.warn({ err }, 'voice isolate billing report failed (non-critical)'));
        }
      }

      res.json(st);
    } catch (e) { next(e); }
  });

  // Fetch isolated audio bytes (defaults to the vocal stem; ?stem=instrumental for the other one)
  r.get('/isolations/:id/audio', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice isolation is not configured.' }); return; }
      await touch(modalCfg);
      const stem = req.query.stem === 'instrumental' ? 'instrumental' : 'vocals';
      const wav = await modalAudio(modalCfg, `/isolate/${req.params.id}/result?stem=${stem}`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // Delete an isolation job (cleanup)
  r.delete('/isolations/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice isolation is not configured.' }); return; }
      await touch(modalCfg);
      await modalRequest(modalCfg, `/isolate/${req.params.id}`, { method: 'DELETE' });
      await supabase.from('voice_isolations')
        .delete()
        .eq('modal_job_id', req.params.id)
        .eq('user_id', userId);
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
    log.error({ err }, 'voice isolate error');
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return r;
})();
