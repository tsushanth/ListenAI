// Speech-to-speech voice conversion: proxy to the Modal voice-convert-dev Seed-VC app.
// Authenticated users with an active TTS billing subscription can convert speech
// from one voice to another. Usage is tracked per conversion.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { isBillingActiveForUser, reportVoiceConvertUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceConvert' });

// --------------------------------------------------------------------------
// Modal client
// --------------------------------------------------------------------------

const VOICE_CONVERT_URL = config.VOICE_CONVERT_URL;
const VOICE_CONVERT_SECRET = config.VOICE_CONVERT_SECRET;

function authHeaders() {
  return { Authorization: VOICE_CONVERT_SECRET ? `Bearer ${VOICE_CONVERT_SECRET}` : '' };
}

async function modalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!VOICE_CONVERT_URL) throw new Error('Voice conversion is not configured');
  const url = `${VOICE_CONVERT_URL}${path}`;
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-convert returned HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

async function modalAudio(path: string): Promise<Buffer> {
  if (!VOICE_CONVERT_URL) throw new Error('Voice conversion is not configured');
  const res = await fetch(`${VOICE_CONVERT_URL}${path}`, { headers: authHeaders() });
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
    // Accept all files; MIME-type validation is done in the route handler
    // so we can return a proper 400 with context instead of multer's generic error.
    cb(null, true);
  },
});

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const voiceConvertRouter: Router = (() => {
  const r = Router();

  // Dark by default
  r.use((_req, res, next) => {
    if (!VOICE_CONVERT_URL || !VOICE_CONVERT_SECRET) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  });

  const limiter = rateLimit({
    windowMs: 3600_000,
    max: 10, // 10 conversions/hour per user
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice-convert:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can convert 10 voices per hour.' },
  });

  // Submit a conversion job
  r.post('/conversions', requireUserMiddleware, limiter, upload.fields([
    { name: 'source', maxCount: 1 },
    { name: 'target', maxCount: 1 },
  ]), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const files = req.files as Record<string, Express.Multer.File[]>;
      const sourceFile = files?.source?.[0];
      const targetFile = files?.target?.[0];

      if (!sourceFile || !targetFile) {
        res.status(400).json({ error: 'Both source and target audio files are required.' });
        return;
      }

      // Validate MIME types
      const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'];
      if (!allowedMimes.includes(sourceFile.mimetype)) {
        res.status(400).json({ error: `Unsupported source format: ${sourceFile.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }
      if (!allowedMimes.includes(targetFile.mimetype)) {
        res.status(400).json({ error: `Unsupported target format: ${targetFile.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }

      // Validate consent attestation
      const consent = cleanStr(req.body?.consent_statement, 500);
      const expectedConsent =
        'I confirm that I have the legal right to use both the source audio and the target voice reference, ' +
        'and that this conversion does not impersonate any person without their consent.';
      if (consent !== expectedConsent) {
        res.status(400).json({ error: 'consent_statement must echo the exact consent text.' });
        return;
      }

      // Build multipart form and forward to Modal
      const formData = new FormData();
      formData.append('source', new Blob([new Uint8Array(sourceFile.buffer)]), sourceFile.originalname || 'source.wav');
      formData.append('target', new Blob([new Uint8Array(targetFile.buffer)]), targetFile.originalname || 'target.wav');

      const modalRes = await fetch(`${VOICE_CONVERT_URL}/convert`, {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      });

      if (!modalRes.ok) {
        const text = await modalRes.text().catch(() => '');
        throw new Error(`Modal returned HTTP ${modalRes.status}: ${text}`);
      }

      const result = await modalRes.json() as { job_id: string; status: string; source_seconds?: number; target_seconds?: number };

      // Track the job for history
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
      const st = await modalRequest<{ status: string; [key: string]: unknown }>(`/convert/${req.params.id}`);

      // Update status in our DB when done/failed
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
      const wav = await modalAudio(`/convert/${req.params.id}/result`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // Delete a conversion job (cleanup)
  r.delete('/conversions/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      await modalRequest(`/convert/${req.params.id}`, { method: 'DELETE' });
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
