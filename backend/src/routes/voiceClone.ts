// XTTS v2 instant voice cloning: proxy to the Modal xtts-clone app.
// Authenticated users with an active TTS subscription can clone voices
// from ~6 seconds of reference audio and synthesize text with them.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { isBillingActiveForUser, reportTtsUsage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceClone' });

// --------------------------------------------------------------------------
// Modal client
// --------------------------------------------------------------------------

const XTTS_CLONE_URL = config.XTTS_CLONE_URL;
const XTTS_CLONE_SECRET = config.XTTS_CLONE_SECRET;

function authHeaders() {
  return { Authorization: XTTS_CLONE_SECRET ? `Bearer ${XTTS_CLONE_SECRET}` : '', 'Content-Type': 'application/json' };
}

async function modalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!XTTS_CLONE_URL) throw new Error('Voice cloning is not configured');
  const url = `${XTTS_CLONE_URL}${path}`;
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal xtts-clone returned HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

async function modalAudio(path: string): Promise<Buffer> {
  if (!XTTS_CLONE_URL) throw new Error('Voice cloning is not configured');
  const res = await fetch(`${XTTS_CLONE_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal xtts-clone returned HTTP ${res.status}: ${text}`);
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
  if (!active) { res.status(402).json({ error: 'Voice cloning requires an active TTS subscription.' }); return null; }

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
// File upload
// --------------------------------------------------------------------------

const MAX_AUDIO_MB = 25;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 },
  fileFilter: (_req, _file, cb) => { cb(null, true); },
});

const SUPPORTED_LANGS = new Set(['en','es','fr','de','it','pt','pl','tr','ru','nl','cs','ar','zh','ja','hu','ko']);
const MAX_TEXT_LENGTH = 5000;

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const voiceCloneRouter: Router = (() => {
  const r = Router();

  // Dark by default
  r.use((_req, res, next) => {
    if (!XTTS_CLONE_URL || !XTTS_CLONE_SECRET) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  });

  const cloneLimiter = rateLimit({
    windowMs: 3600_000,
    max: 5, // 5 clones/hour per user
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice-clone:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can create 5 voice clones per hour.' },
  });

  // ------------------------------------------------------------------------
  // POST / — clone a voice from reference audio
  // ------------------------------------------------------------------------
  r.post('/', requireUserMiddleware, cloneLimiter, upload.single('reference'), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const file = req.file;
      if (!file || file.size < 1024) {
        res.status(400).json({ error: 'Reference audio file is required.' });
        return;
      }

      const allowedMimes = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/mp3'];
      if (!allowedMimes.includes(file.mimetype)) {
        res.status(400).json({ error: `Unsupported audio format: ${file.mimetype}. Allowed: WAV, FLAC, OGG, MP3, M4A.` });
        return;
      }

      const consent = cleanStr(req.body?.consent_statement, 500);
      const expectedConsent =
        'I confirm that I have the legal right to clone this voice and agree to the Terms of Use. ' +
        'I will not use this feature to impersonate any person without their consent.';
      if (consent !== expectedConsent) {
        res.status(400).json({ error: 'consent_statement must echo the exact consent text.' });
        return;
      }

      const name = cleanStr(req.body?.name, 100) || 'My cloned voice';
      const language = cleanStr(req.body?.language, 10) || 'en';
      if (!SUPPORTED_LANGS.has(language)) {
        res.status(400).json({ error: `Unsupported language: ${language}` });
        return;
      }

      // Forward to Modal
      const formData = new FormData();
      formData.append('name', name);
      formData.append('language', language);
      formData.append('reference', new Blob([new Uint8Array(file.buffer)]), file.originalname || 'reference.wav');

      const modalRes = await fetch(`${XTTS_CLONE_URL}/voices`, {
        method: 'POST',
        headers: { Authorization: XTTS_CLONE_SECRET ? `Bearer ${XTTS_CLONE_SECRET}` : '' },
        body: formData,
      });

      if (!modalRes.ok) {
        const text = await modalRes.text().catch(() => '');
        throw new Error(`Modal returned HTTP ${modalRes.status}: ${text}`);
      }

      const meta = await modalRes.json() as {
        voice_id: string;
        status: string;
        name: string;
        language: string;
        reference_seconds?: number;
      };

      // Persist ownership in our DB (idempotent — same audio hash = same modal_voice_id)
      const { data: existing, error: lookupErr } = await supabase
        .from('xtts_cloned_voices')
        .select('id')
        .eq('user_id', userId)
        .eq('modal_voice_id', meta.voice_id)
        .maybeSingle();

      if (lookupErr) throw lookupErr;

      let dbId: string;
      if (existing) {
        dbId = existing.id;
        // Update name in case user renamed it
        await supabase.from('xtts_cloned_voices')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', dbId);
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('xtts_cloned_voices')
          .insert({
            user_id: userId,
            modal_voice_id: meta.voice_id,
            name,
            language,
            reference_seconds: meta.reference_seconds ?? null,
            status: meta.status === 'ready' ? 'ready' : 'failed',
          })
          .select('id')
          .single();
        if (insertErr) throw insertErr;
        dbId = inserted.id;
      }

      res.status(201).json({
        id: dbId,
        modal_voice_id: meta.voice_id,
        name,
        language,
        reference_seconds: meta.reference_seconds ?? null,
        status: meta.status,
      });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // GET / — list cloned voices
  // ------------------------------------------------------------------------
  r.get('/', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('xtts_cloned_voices')
        .select('id, modal_voice_id, name, language, reference_seconds, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json({ voices: data ?? [] });
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // GET /:id — get voice metadata
  // ------------------------------------------------------------------------
  r.get('/:id', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('xtts_cloned_voices')
        .select('id, modal_voice_id, name, language, reference_seconds, status, created_at')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Voice not found.' }); return; }
      res.json(data);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // GET /:id/reference — proxy original reference audio from Modal
  // ------------------------------------------------------------------------
  r.get('/:id/reference', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('xtts_cloned_voices')
        .select('modal_voice_id')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Voice not found.' }); return; }

      const wav = await modalAudio(`/voices/${data.modal_voice_id}/reference`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // POST /:id/synthesize — synthesize text with cloned voice
  // ------------------------------------------------------------------------
  r.post('/:id/synthesize', requireUserMiddleware, express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const text = cleanStr(req.body?.text, MAX_TEXT_LENGTH);
      if (!text || text.length < 1) { res.status(400).json({ error: 'Text is required.' }); return; }

      const language = cleanStr(req.body?.language, 10) || 'en';
      if (!SUPPORTED_LANGS.has(language)) {
        res.status(400).json({ error: `Unsupported language: ${language}` });
        return;
      }

      const { data, error } = await supabase
        .from('xtts_cloned_voices')
        .select('modal_voice_id')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Voice not found.' }); return; }

      const wav = await modalAudio(`/voices/${data.modal_voice_id}/synthesize`);

      // Report TTS usage (best-effort)
      reportTtsUsage(userId, text.length).catch((err: unknown) =>
        log.warn({ err, userId, charCount: text.length }, 'TTS billing report failed (non-critical)')
      );

      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // ------------------------------------------------------------------------
  // DELETE /:id — delete cloned voice
  // ------------------------------------------------------------------------
  r.delete('/:id', requireUserMiddleware, async (req, res, next) => {
    try {
      const userId = (req as Request & { userId?: string }).userId!;
      const { data, error } = await supabase
        .from('xtts_cloned_voices')
        .select('modal_voice_id')
        .eq('id', req.params.id)
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) { res.status(404).json({ error: 'Voice not found.' }); return; }

      // Best-effort delete from Modal volume
      await modalRequest(`/voices/${data.modal_voice_id}`, { method: 'DELETE' }).catch((err: unknown) => {
        log.warn({ err, modal_voice_id: data.modal_voice_id }, 'Modal delete failed (non-critical)');
      });

      await supabase.from('xtts_cloned_voices').delete().eq('id', req.params.id).eq('user_id', userId);
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
    log.error({ err }, 'voice clone error');
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return r;
})();
