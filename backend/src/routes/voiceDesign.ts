// Voice Design: proxy to the Modal voice-design-dev Parler-TTS app.
// Authenticated users with an active TTS billing subscription can generate
// voices from text descriptions. Usage is tracked per generation.
import express, { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../lib/config.js';
import { supabase } from '../lib/supabaseClient.js';
import { isBillingActiveForUser } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'voiceDesign' });

// --------------------------------------------------------------------------
// Modal client
// --------------------------------------------------------------------------

const VOICE_DESIGN_URL = config.VOICE_DESIGN_URL;
const VOICE_DESIGN_SECRET = config.VOICE_DESIGN_SECRET;

function authHeaders() {
  return { Authorization: VOICE_DESIGN_SECRET ? `Bearer ${VOICE_DESIGN_SECRET}` : '', 'Content-Type': 'application/json' };
}

async function modalRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!VOICE_DESIGN_URL) throw new Error('Voice design is not configured');
  const url = `${VOICE_DESIGN_URL}${path}`;
  const res = await fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-design returned HTTP ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as T;
}

async function modalAudio(path: string): Promise<Buffer> {
  if (!VOICE_DESIGN_URL) throw new Error('Voice design is not configured');
  const res = await fetch(`${VOICE_DESIGN_URL}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Modal voice-design returned HTTP ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) { res.status(401).json({ error: 'Invalid token.' }); return null; }

  const active = await isBillingActiveForUser(user.id);
  if (!active) { res.status(402).json({ error: 'Voice design requires an active TTS subscription.' }); return null; }

  return user.id;
}

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export const voiceDesignRouter: Router = (() => {
  const r = Router();

  // Dark by default
  r.use((_req, res, next) => {
    if (!VOICE_DESIGN_URL || !VOICE_DESIGN_SECRET) { res.status(404).json({ error: 'Not found' }); return; }
    next();
  });

  const limiter = rateLimit({
    windowMs: 3600_000,
    max: 12, // 12 generations/hour per user
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `voice-design:${(req as Request & { userId?: string }).userId ?? 'anon'}`,
    validate: false,
    message: { error: 'Too many requests. You can generate 12 voices per hour.' },
  });

  // List saved presets
  r.get('/presets', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const { data, error: dbError } = await supabase
        .from('voice_design_presets')
        .select('id, name, description, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (dbError) throw dbError;
      res.json({ presets: data || [] });
    } catch (e) { next(e); }
  });

  // Save a preset
  r.post('/presets', express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const name = cleanStr(req.body?.name, 100);
      const description = cleanStr(req.body?.description, 800);
      if (!name || name.length < 2) { res.status(400).json({ error: 'Name must be at least 2 characters.' }); return; }
      if (!description || description.length < 10) { res.status(400).json({ error: 'Description must be at least 10 characters.' }); return; }
      const { data, error: dbError } = await supabase
        .from('voice_design_presets')
        .insert({ user_id: userId, name, description })
        .select('id, name, description, created_at')
        .single();
      if (dbError) throw dbError;
      res.status(201).json(data);
    } catch (e) { next(e); }
  });

  // Delete a preset
  r.delete('/presets/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const { error: dbError } = await supabase
        .from('voice_design_presets')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', userId);
      if (dbError) throw dbError;
      res.json({ deleted: true });
    } catch (e) { next(e); }
  });

  // Create a generation job
  r.post('/designs', limiter, express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const description = cleanStr(req.body?.description, 800);
      const text = cleanStr(req.body?.text, 500);
      if (!description || description.length < 10) { res.status(400).json({ error: 'Description must be at least 10 characters.' }); return; }
      if (!text || text.length < 1) { res.status(400).json({ error: 'Sample text is required.' }); return; }

      const result = await modalRequest<{ job_id: string; status: string }>('/designs', {
        method: 'POST',
        body: JSON.stringify({ description, text }),
      });

      // Track the job for history
      const { error: dbError } = await supabase.from('voice_design_jobs').insert({
        user_id: userId,
        modal_job_id: result.job_id,
        description,
        sample_text: text,
        status: 'queued',
      });
      if (dbError) log.warn({ dbError }, 'Failed to insert voice_design_jobs row (non-critical)');

      res.status(201).json({ job_id: result.job_id, status: result.status });
    } catch (e) { next(e); }
  });

  // Poll a job
  r.get('/designs/:id', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const status = await modalRequest<{ status: string; ready_at?: string; timings?: Record<string, number> }>(`/designs/${req.params.id}`);

      // Update status in our DB when ready/failed
      if (status.status === 'ready' || status.status === 'failed') {
        await supabase.from('voice_design_jobs')
          .update({ status: status.status, completed_at: new Date().toISOString() })
          .eq('modal_job_id', req.params.id)
          .eq('user_id', userId);
      }

      res.json(status);
    } catch (e) { next(e); }
  });

  // Fetch audio bytes
  r.get('/designs/:id/audio', async (req, res, next) => {
    try {
      const userId = await requireUser(req, res);
      if (!userId) return;
      const wav = await modalAudio(`/designs/${req.params.id}/audio`);
      res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=300' }).send(wav);
    } catch (e) { next(e); }
  });

  // Error handler
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'voice design error');
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return r;
})();
