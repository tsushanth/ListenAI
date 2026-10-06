// Speech-to-speech voice conversion: self-serve per-user Modal deployments.
// The backend deploys a Modal Seed-VC app on behalf of each user (with their own GPU container)
// and tears it down when requested.  This keeps audio off our servers and gives users cost control.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage, reportVoiceConvertUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';
import { decideDeploy } from '../lib/perUserDeploy.js';

const log = logger.child({ module: 'voiceConvert' });

const execAsync = promisify(exec);

// --------------------------------------------------------------------------
// Per-user deployment helpers
// --------------------------------------------------------------------------

interface UserDeployment {
  app_name: string;
  modal_url: string;
  modal_secret: string;
  status: string;
  updated_at?: string | null;
  job_count: number;
}

async function getUserDeployment(userId: string): Promise<UserDeployment | null> {
  const { data, error } = await supabase
    .from('user_voice_convert_deployments')
    .select('app_name, modal_url, modal_secret, status, updated_at')
    .eq('user_id', userId)
    .single();
  if (error || !data || Array.isArray(data)) return null;
  return data as UserDeployment;
}

async function getGlobalFallback(): Promise<{ modal_url: string; modal_secret: string } | null> {
  if (config.VOICE_CONVERT_URL && config.VOICE_CONVERT_SECRET) {
    return { modal_url: config.VOICE_CONVERT_URL, modal_secret: config.VOICE_CONVERT_SECRET };
  }
  return null;
}

async function getUserModalConfig(userId: string): Promise<{ modal_url: string; modal_secret: string } | null> {
  const dep = await getUserDeployment(userId);
  if (dep && dep.status === 'ready') {
    return { modal_url: dep.modal_url, modal_secret: dep.modal_secret };
  }
  return getGlobalFallback();
}

function randomHex(len: number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
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
// Modal CLI helpers
// --------------------------------------------------------------------------

function modalEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MODAL_TOKEN_ID: config.MODAL_TOKEN_ID || '',
    MODAL_TOKEN_SECRET: config.MODAL_TOKEN_SECRET || '',
    MODAL_SERVER_URL: 'https://api.modal.com',
  };
}

async function modalSecretCreate(name: string, key: string, value: string): Promise<void> {
  // Current Modal CLI (`modal secret create --help`) takes plain KEY=VALUE
  // pairs, not base64 — there is no --base64 flag. `value` here is always
  // our own randomHex(32) output (alphanumeric, no shell metacharacters),
  // so passing it unescaped through this shell string is safe for this
  // call site specifically, not in general.
  const cmd = `modal secret create ${name} ${key}=${value} --force`;
  await execAsync(cmd, { env: modalEnv(), timeout: 30000 });
}

async function modalDeploy(appSuffix: string, secretName: string): Promise<void> {
  const deployEnv = {
    ...modalEnv(),
    VOICE_CONVERT_APP_SUFFIX: appSuffix,
    VOICE_CONVERT_SECRET_NAME: secretName,
  };
  const { stdout, stderr } = await execAsync(
    'modal deploy modal/convert_job.py',
    { env: deployEnv, timeout: 180000, cwd: process.cwd() }
  );
  log.info({ stdout, stderr }, 'modal deploy output');
}

async function modalAppStop(appName: string): Promise<void> {
  await execAsync(`modal app stop ${appName}`, { env: modalEnv(), timeout: 30000 });
}

// Indirection so tests can stub the Modal CLI (no subprocess in unit tests).
export const modalOps = { secretCreate: modalSecretCreate, deploy: modalDeploy, appStop: modalAppStop };

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function requireUser(req: Request, res: Response): Promise<string | null> {
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

  r.get('/deploy', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const dep = await getUserDeployment(userId);
      if (!dep) {
        // A shared endpoint serves everyone: report it as ready instead of a 404 that sends clients into POST /deploy.
        if (await getGlobalFallback()) { res.json({ status: 'ready', shared: true }); return; }
        res.status(404).json({ error: 'No deployment found.' });
        return;
      }
      // Never return the secret
      res.json({ app_name: dep.app_name, modal_url: dep.modal_url, status: dep.status });
    } catch (e) { next(e); }
  });

  r.post('/deploy', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const existing = await getUserDeployment(userId);
      const decision = decideDeploy({
        existing,
        sharedConfigured: !!(await getGlobalFallback()),
        perUserDeployForced: process.env.VOICE_PER_USER_DEPLOY === '1',
      });
      if (decision.action === 'shared') {
        // The backend already has a shared, always-available endpoint: no per-user `modal deploy` (209 s uncached,
        // against a 180 s timeout) and nothing to wait for.
        res.status(200).json({ status: 'ready', shared: true });
        return;
      }
      if (decision.action === 'conflict') {
        res.status(409).json({
          error: decision.reason === 'in_progress' ? 'A deployment is already in progress.' : 'You already have an active deployment.',
          deployment: existing && { app_name: existing.app_name, modal_url: existing.modal_url, status: existing.status },
        });
        return;
      }

      // Check backend Modal credentials
      if (!config.MODAL_TOKEN_ID || !config.MODAL_TOKEN_SECRET) {
        res.status(503).json({ error: 'Voice conversion deployment is not configured on this backend.' });
        return;
      }

      const suffix = `user-${userId.slice(0, 8)}-${randomHex(4)}`;
      const appName = `voice-convert-dev-${suffix}`;
      const secretName = `voice-convert-${suffix}`;
      const secretValue = randomHex(32);
      const workspace = config.MODAL_WORKSPACE || 't-sushanth';
      const modalUrl = `https://${workspace}--${appName}-api.modal.run`;

      if (decision.action === 'retry' && existing) {
        // A failed (or stuck) attempt used to block this user forever. Drop the dead row, stop whatever it left
        // behind (best effort; scripts/cleanup-stale-voice-deployments.ts sweeps leftovers) and start over.
        log.info({ userId, previous: existing.app_name, previousStatus: existing.status }, 'retrying convert deployment');
        await supabase.from('user_voice_convert_deployments').delete().eq('user_id', userId);
        modalOps.appStop(existing.app_name).catch((err: unknown) => log.warn({ userId, err }, 'stop of previous convert app failed (non-critical)'));
      }

      // Insert deploying row. user_id is the primary key, so a concurrent POST loses here instead of double-deploying.
      const { error: insertError } = await supabase.from('user_voice_convert_deployments').insert({
        user_id: userId,
        app_name: appName,
        modal_url: modalUrl,
        modal_secret: secretValue,
        status: 'deploying',
        job_count: 0,
      });
      if (insertError) {
        res.status(409).json({ error: 'A deployment is already in progress.' });
        return;
      }

      // Fire-and-forget the actual deployment (Update DB on finish)
      (async () => {
        try {
          await modalOps.secretCreate(secretName, 'CONVERT_SECRET', secretValue);
          await modalOps.deploy(`-${suffix}`, secretName);
          await supabase.from('user_voice_convert_deployments')
            .update({ status: 'ready', updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('app_name', appName); // a late finish of a superseded attempt must not touch its replacement
          log.info({ userId, appName }, 'voice convert deployment ready');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ userId, appName, err }, 'voice convert deployment failed');
          await supabase.from('user_voice_convert_deployments')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('app_name', appName); // a late finish of a superseded attempt must not touch its replacement
        }
      })();

      res.status(202).json({ app_name: appName, modal_url: modalUrl, status: 'deploying' });
    } catch (e) { next(e); }
  });

  r.delete('/deploy', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const dep = await getUserDeployment(userId);
      if (!dep) { res.status(404).json({ error: 'No deployment found.' }); return; }

      if (dep.status === 'ready' || dep.status === 'deploying') {
        await supabase.from('user_voice_convert_deployments')
          .update({ status: 'stopping', updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      }

      // Best-effort stop
      try { await modalOps.appStop(dep.app_name); } catch (err: unknown) {
        log.warn({ userId, app_name: dep.app_name, err }, 'modal app stop failed (may already be stopped)');
      }

      await supabase.from('user_voice_convert_deployments').delete().eq('user_id', userId);
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

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
      const modalCfg = await getUserModalConfig(userId);
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

      // Track job count on deployment
      const dep = await getUserDeployment(userId);
      if (dep) {
        await supabase.from('user_voice_convert_deployments')
          .update({ job_count: dep.job_count + 1, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      }

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

      const st = await modalRequest<{ status: string; [key: string]: unknown }>(modalCfg, `/convert/${req.params.id}`);

      if (st.status === 'done' || st.status === 'failed') {
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
