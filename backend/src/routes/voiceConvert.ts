// Speech-to-speech voice conversion: self-serve per-user Modal endpoints.
// Each user deploys their own Modal app (convert_job.py) and stores the URL + secret here.
// The backend proxies conversion requests to the user's Modal instance.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { supabase } from '../lib/supabaseClient.js';
import { isBillingActiveForUser, reportVoiceConvertUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceConvert' });

// --------------------------------------------------------------------------
// Per-user config helpers
// --------------------------------------------------------------------------

interface UserVoiceConvertConfig {
  modal_url: string;
  modal_secret: string;
}

async function getUserConfig(userId: string): Promise<UserVoiceConvertConfig | null> {
  const { data, error } = await supabase
    .from('user_voice_convert_configs')
    .select('modal_url, modal_secret')
    .eq('user_id', userId)
    .single();
  if (error || !data || Array.isArray(data)) return null;
  return data as UserVoiceConvertConfig;
}

function authHeaders(secret: string) {
  return { Authorization: secret ? `Bearer ${secret}` : '' };
}

async function modalRequest<T>(
  cfg: UserVoiceConvertConfig,
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

async function modalAudio(cfg: UserVoiceConvertConfig, path: string): Promise<Buffer> {
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

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const cached = (req as Request & { userId?: string }).userId;
  if (cached) return cached;

  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }

  const active = await isBillingActiveForUser(user.id);
  if (!active) { res.status(402).json({ error: 'Voice conversion requires an active TTS subscription.' }); return null; }

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
  // Config management
  // ------------------------------------------------------------------------

  r.get('/config', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const cfg = await getUserConfig(userId);
      if (!cfg) { res.status(404).json({ error: 'No configuration found.' }); return; }
      // Never return the secret to the client
      res.json({ modal_url: cfg.modal_url, configured: true });
    } catch (e) { next(e); }
  });

  r.post('/config', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const url = cleanStr(req.body?.modal_url, 500);
      const secret = cleanStr(req.body?.modal_secret, 500);

      if (!url) { res.status(400).json({ error: 'modal_url is required.' }); return; }
      if (!secret) { res.status(400).json({ error: 'modal_secret is required.' }); return; }
      if (!url.startsWith('https://')) { res.status(400).json({ error: 'modal_url must be an HTTPS URL.' }); return; }

      const { error } = await supabase
        .from('user_voice_convert_configs')
        .upsert({ user_id: userId, modal_url: url, modal_secret: secret, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' });
      if (error) {
        log.error({ error }, 'Failed to save voice convert config');
        res.status(500).json({ error: 'Could not save configuration.' });
        return;
      }
      res.json({ configured: true, modal_url: url });
    } catch (e) { next(e); }
  });

  r.delete('/config', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      await supabase.from('user_voice_convert_configs').delete().eq('user_id', userId);
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
      const cfg = await getUserConfig(userId);
      if (!cfg) {
        res.status(400).json({ error: 'Voice conversion is not configured. Deploy your own Modal app and save the URL + secret in Settings first.' });
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

      const modalRes = await fetch(`${cfg.modal_url}/convert`, {
        method: 'POST',
        headers: authHeaders(cfg.modal_secret),
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

      const statusCode = result.status === 'rejected' ? 400 : 202;
      res.status(statusCode).json({ job_id: result.job_id, status: result.status });
    } catch (e) { next(e); }
  });

  // Poll a conversion job
  r.get('/conversions/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const cfg = await getUserConfig(userId);
      if (!cfg) { res.status(400).json({ error: 'Voice conversion is not configured.' }); return; }

      const st = await modalRequest<{ status: string; [key: string]: unknown }>(cfg, `/convert/${req.params.id}`);

      if (st.status === 'done' || st.status === 'failed') {
        await supabase.from('voice_conversions')
          .update({ status: st.status, completed_at: new Date().toISOString(), error: (st as any).stderr_tail || null })
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId);
        if (st.status === 'done') {
          reportVoiceConvertUsage(userId).catch((err: unknown) => log.warn({ err }, 'voice convert billing report failed (non-critical)'));
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
      const cfg = await getUserConfig(userId);
      if (!cfg) { res.status(400).json({ error: 'Voice conversion is not configured.' }); return; }
      const wav = await modalAudio(cfg, `/convert/${req.params.id}/result`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // Delete a conversion job (cleanup)
  r.delete('/conversions/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const cfg = await getUserConfig(userId);
      if (!cfg) { res.status(400).json({ error: 'Voice conversion is not configured.' }); return; }
      await modalRequest(cfg, `/convert/${req.params.id}`, { method: 'DELETE' });
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
