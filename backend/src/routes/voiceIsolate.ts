// Vocal isolation (Demucs htdemucs): self-serve per-user Modal deployments.
// The backend deploys a Modal Demucs app on behalf of each user (with their own GPU container)
// and tears it down when requested.  This keeps audio off our servers and gives users cost control.
// Mirrors voiceConvert.ts's pattern exactly - see that file for the fuller rationale comments.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { isBillingActiveForUser, reportVoiceIsolateUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceIsolate' });

const execAsync = promisify(exec);

// --------------------------------------------------------------------------
// Per-user deployment helpers
// --------------------------------------------------------------------------

interface UserDeployment {
  app_name: string;
  modal_url: string;
  modal_secret: string;
  status: string;
  job_count: number;
}

async function getUserDeployment(userId: string): Promise<UserDeployment | null> {
  const { data, error } = await supabase
    .from('user_voice_isolate_deployments')
    .select('app_name, modal_url, modal_secret, status')
    .eq('user_id', userId)
    .single();
  if (error || !data || Array.isArray(data)) return null;
  return data as UserDeployment;
}

async function getGlobalFallback(): Promise<{ modal_url: string; modal_secret: string } | null> {
  if (config.VOICE_ISOLATE_URL && config.VOICE_ISOLATE_SECRET) {
    return { modal_url: config.VOICE_ISOLATE_URL, modal_secret: config.VOICE_ISOLATE_SECRET };
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
    VOICE_ISOLATE_APP_SUFFIX: appSuffix,
    VOICE_ISOLATE_SECRET_NAME: secretName,
  };
  const { stdout, stderr } = await execAsync(
    'modal deploy modal/isolate_job.py',
    { env: deployEnv, timeout: 180000, cwd: process.cwd() }
  );
  log.info({ stdout, stderr }, 'modal deploy output');
}

async function modalAppStop(appName: string): Promise<void> {
  await execAsync(`modal app stop ${appName}`, { env: modalEnv(), timeout: 30000 });
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const cached = (req as Request & { userId?: string }).userId;
  if (cached) return cached;

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }

  const active = await isBillingActiveForUser(user.id);
  if (!active) { res.status(402).json({ error: 'Voice isolation requires an active TTS subscription.' }); return null; }

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

  r.get('/deploy', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const dep = await getUserDeployment(userId);
      if (!dep) { res.status(404).json({ error: 'No deployment found.' }); return; }
      // Never return the secret
      res.json({ app_name: dep.app_name, modal_url: dep.modal_url, status: dep.status });
    } catch (e) { next(e); }
  });

  r.post('/deploy', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const existing = await getUserDeployment(userId);
      if (existing) {
        res.status(409).json({ error: 'You already have an active deployment.', deployment: { app_name: existing.app_name, modal_url: existing.modal_url, status: existing.status } });
        return;
      }

      // Check backend Modal credentials
      if (!config.MODAL_TOKEN_ID || !config.MODAL_TOKEN_SECRET) {
        res.status(503).json({ error: 'Voice isolation deployment is not configured on this backend.' });
        return;
      }

      const suffix = `user-${userId.slice(0, 8)}-${randomHex(4)}`;
      const appName = `voice-isolate-dev-${suffix}`;
      const secretName = `voice-isolate-${suffix}`;
      const secretValue = randomHex(32);
      const workspace = config.MODAL_WORKSPACE || 't-sushanth';
      const modalUrl = `https://${workspace}--${appName}-api.modal.run`;

      // Insert deploying row
      await supabase.from('user_voice_isolate_deployments').insert({
        user_id: userId,
        app_name: appName,
        modal_url: modalUrl,
        modal_secret: secretValue,
        status: 'deploying',
        job_count: 0,
      });

      // Fire-and-forget the actual deployment (Update DB on finish)
      (async () => {
        try {
          await modalSecretCreate(secretName, 'ISOLATE_SECRET', secretValue);
          await modalDeploy(`-${suffix}`, secretName);
          await supabase.from('user_voice_isolate_deployments')
            .update({ status: 'ready', updated_at: new Date().toISOString() })
            .eq('user_id', userId);
          log.info({ userId, appName }, 'voice isolate deployment ready');
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ userId, appName, err }, 'voice isolate deployment failed');
          await supabase.from('user_voice_isolate_deployments')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('user_id', userId);
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
        await supabase.from('user_voice_isolate_deployments')
          .update({ status: 'stopping', updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      }

      // Best-effort stop
      try { await modalAppStop(dep.app_name); } catch (err: unknown) {
        log.warn({ userId, app_name: dep.app_name, err }, 'modal app stop failed (may already be stopped)');
      }

      await supabase.from('user_voice_isolate_deployments').delete().eq('user_id', userId);
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // Isolation jobs
  // ------------------------------------------------------------------------

  // Submit an isolation job
  r.post('/isolations', requireUserMiddleware, limiter, upload.fields([
    { name: 'input', maxCount: 1 },
  ]), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const modalCfg = await getUserModalConfig(userId);
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

      // Track job count on deployment
      const dep = await getUserDeployment(userId);
      if (dep) {
        await supabase.from('user_voice_isolate_deployments')
          .update({ job_count: dep.job_count + 1, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      }

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

      const st = await modalRequest<{ status: string; [key: string]: unknown }>(modalCfg, `/isolate/${req.params.id}`);

      if (st.status === 'done' || st.status === 'failed') {
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
