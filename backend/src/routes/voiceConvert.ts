// Speech-to-speech voice conversion: self-serve per-user Modal deployments.
// The backend deploys a Modal Seed-VC app on behalf of each user (with their own GPU container)
// and tears it down when requested.  This keeps audio off our servers and gives users cost control.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { getDeploymentManager, type DeployTarget } from '../lib/modalDeployments.js';
import { recordModalUsage } from '../lib/modalUsage.js';
import { mountDeploymentRoutes } from './deployments.js';
import { supabase } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportVoiceConvertUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceConvert' });


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
  const target = await getDeploymentManager().resolveTarget(userId, 'convert', { forNewWork });
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
    throw new Error(`Modal voice-convert returned HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

async function modalAudio(cfg: { modal_url: string; modal_secret: string }, path: string): Promise<Buffer> {
  const res = await fetch(`${cfg.modal_url}${path}`, { headers: authHeaders(cfg.modal_secret) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-convert returned HTTP ${res.status}: ${text}`);
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
  // Identity: req.userId is set upstream by requireAuthOrApiKey (gateway-forwarded API key OR verified JWT);
  // fall back to verifying the bearer token ourselves so the router still works mounted standalone.
  let userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }
    userId = user.id;
  }

  (req as Request & { userId?: string }).userId = userId;
  return userId;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await resolveIdentity(req, res);
  if (!userId) return null;

  // Billing is checked for EVERY resolved identity, including one already set by requireAuthOrApiKey. (The
  // sibling routes short-circuit on a pre-set req.userId and skip this check, which would let any
  // authenticated caller past the subscription gate once the bridge middleware is mounted in front.)
  const active = await hasUsageAllowance(userId);
  if (!active) { res.status(402).json({ error: freeCreditsExhaustedMessage('voice conversion') }); return null; }

  (req as Request & { userId?: string }).userId = userId;
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

const MAX_AUDIO_MB = 25;
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

export const voiceConvertRouter: Router = (() => {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 3600_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice-convert:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can convert 10 voices per hour.' },
  });

  // ------------------------------------------------------------------------
  // Deployment management
  // ------------------------------------------------------------------------

  // Identity only: see resolveIdentity().
  mountDeploymentRoutes(r, 'convert', requireIdentityMiddleware);

  // ------------------------------------------------------------------------
  // Conversion jobs
  // ------------------------------------------------------------------------

  // Submit a conversion job
  r.post('/conversions', requireUserMiddleware, limiter, upload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'target', maxCount: 1 },
  ]), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const modalCfg = await getUserModalConfig(userId, true); // new work: refused in the last minutes of a deployment's life
      if (!modalCfg) {
        res.status(400).json({ error: 'Voice conversion is not configured. Deploy a converter first (POST /api/voice-convert/deploy).', code: 'deployment_required' });
        return;
      }

      const files = req.files as Record<string, Express.Multer.File[]>;
      const sourceFile = files?.source?.[0];
      const targetFile = files?.target?.[0];

      if (!sourceFile || !targetFile) {
        res.status(400).json({ error: 'Both source and target audio files are required.' });
        return;
      }

      const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'];
      if (!allowedMimes.includes(sourceFile.mimetype)) {
        res.status(400).json({ error: `Unsupported source format: ${sourceFile.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }
      if (!allowedMimes.includes(targetFile.mimetype)) {
        res.status(400).json({ error: `Unsupported target format: ${targetFile.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }

      const consent = cleanStr(req.body?.consent_statement, 500);
      const expectedConsent =
        'I confirm that I have the legal right to use both the source audio and the target voice reference, ' +
        'and that this conversion does not impersonate any person without their consent.';
      if (consent !== expectedConsent) {
        res.status(400).json({ error: 'consent_statement must echo the exact consent text.' });
        return;
      }

      const formData = new FormData();
      formData.append('source', new Blob([new Uint8Array(sourceFile.buffer)]), sourceFile.originalname || 'source.wav');
      formData.append('target', new Blob([new Uint8Array(targetFile.buffer)]), targetFile.originalname || 'target.wav');

      const modalRes = await fetch(`${modalCfg.modal_url}/convert`, {
        method: 'POST',
        headers: authHeaders(modalCfg.modal_secret),
        body: formData,
      });

      if (!modalRes.ok) {
        const text = await modalRes.text().catch(() => '');
        throw new Error(`Modal returned HTTP ${modalRes.status}: ${text}`);
      }

      const result = await modalRes.json() as { job_id: string; status: string; source_seconds?: number; target_seconds?: number };

      const { error: dbError } = await supabase.from('voice_conversions').insert({
        user_id: userId,
        modal_job_id: result.job_id,
        source_seconds: result.source_seconds ?? null,
        target_seconds: result.target_seconds ?? null,
        status: result.status === 'rejected' ? 'rejected' : 'queued',
      });
      if (dbError) log.warn({ dbError }, 'Failed to insert voice_conversions row (non-critical)');

      // Count the job and restart the deployment's idle clock
      await touch(modalCfg, { job: true });
      const statusCode = result.status === 'rejected' ? 400 : 202;
      res.status(statusCode).json({ job_id: result.job_id, status: result.status });
    } catch (e) { next(e); }
  });

  // Poll a conversion job
  r.get('/conversions/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice conversion is not configured.', code: 'deployment_required' }); return; }
      await touch(modalCfg);

      const st = await modalRequest<{ status: string; [key: string]: unknown }>(modalCfg, `/convert/${req.params.id}`);

      if (st.status === 'done' || st.status === 'failed') {
        // Shadow mode: record the GPU seconds the worker measured for this job (done or failed, both used the GPU).
        // Idempotent per job, so re-polling a finished job does not count it twice. Not billed; see lib/modalUsage.ts.
        if (typeof st.gpu_seconds === 'number') {
          await recordModalUsage({ deploymentId: modalCfg.target.deploymentId, userId, service: 'convert', jobId: req.params.id, gpuSeconds: st.gpu_seconds });
        }
        // Read the row first so a client re-polling an already-completed job is not billed again
        // (the meter event's identifier also dedupes within Stripe's window, this covers beyond it).
        const { data: prior } = await supabase.from('voice_conversions')
          .select('status, source_seconds')
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId)
          .maybeSingle();
        await supabase.from('voice_conversions')
          .update({ status: st.status, completed_at: new Date().toISOString(), error: (st as any).stderr_tail || null })
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId);
        if (st.status === 'done' && prior?.status !== 'done') {
          // Billed per second of SOURCE audio (rounded up, with a minimum), see AUDIO_JOB_PRICING.
          const sourceSeconds = typeof st.source_seconds === 'number' ? st.source_seconds : (prior?.source_seconds as number | null | undefined);
          reportVoiceConvertUsage(userId, sourceSeconds, req.params.id).catch((err: unknown) => log.warn({ err }, 'voice convert billing report failed (non-critical)'));
        }
      }

      res.json(st);
    } catch (e) { next(e); }
  });

  // Fetch converted audio bytes
  r.get('/conversions/:id/audio', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice conversion is not configured.', code: 'deployment_required' }); return; }
      await touch(modalCfg);
      const wav = await modalAudio(modalCfg, `/convert/${req.params.id}/result`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // Delete a conversion job (cleanup)
  r.delete('/conversions/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const modalCfg = await getUserModalConfig(userId);
      if (!modalCfg) { res.status(400).json({ error: 'Voice conversion is not configured.', code: 'deployment_required' }); return; }
      await touch(modalCfg);
      await modalRequest(modalCfg, `/convert/${req.params.id}`, { method: 'DELETE' });
      await supabase.from('voice_conversions')
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
    log.error({ err }, 'voice convert error');
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return r;
})();
