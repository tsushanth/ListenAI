// Consent-gated voice cloning API (Chatterbox Multilingual V3, Perth-watermarked output).
// Contract + safeguards: docs/VOICE_CLONING_CONSENT.md. Dark (503) unless VOICE_CLONE_SERVICE_URL,
// VOICE_CLONE_SERVICE_SECRET and STT_API_KEY are configured.
//
//   POST   /api/voice-clones/consent-challenges   -> { challenge_id, phrase, expires_at }
//   POST   /api/voice-clones        multipart: challenge_id, name, language, consent (audio), reference (audio)
//   GET    /api/voice-clones        list own voices (no audio is ever returned)
//   DELETE /api/voice-clones/:id    delete reference audio, embeddings, cached prompts
//   POST   /api/voice-clones/abuse-reports   public takedown intake (IP rate limited)
//   POST   /api/admin/voice-clones/:id/disable   x-admin-key; abuse takedown
//   POST   /api/admin/voice-clones/purge-expired x-admin-key; retention sweep
//
// Synthesis with a cloned voice goes through /api/tts/cloned and /api/tts/job-cloned (routes/tts.ts).
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import {
  CloneError, createVoiceClone, deleteVoiceClone, disableVoiceClone, issueConsentChallenge, purgeExpired, type CloneDeps,
} from '../lib/voiceCloning/service.js';
import { ServiceUnavailableError } from '../lib/voiceCloning/serviceClient.js';
import { getCloneDeps, planForUser } from '../lib/voiceCloning/runtime.js';
import type { Eligibility } from '../lib/voiceCloning/types.js';

const log = logger.child({ module: 'voiceClones' });

const MAX_AUDIO_MB = 25;
const ALLOWED_MIMES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm']);

export interface VoiceClonesRouterDeps {
  /** null = feature dark. */
  getDeps: () => CloneDeps | null;
  /** null = not signed in. Must verify the token against Supabase (no default-user fallback). */
  resolveEligibility: (req: Request) => Promise<Eligibility | null>;
  adminKey?: () => string | undefined;
}

export async function resolveEligibilityFromSupabase(req: Request): Promise<Eligibility | null> {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return { userId: user.id, emailVerified: !!user.email_confirmed_at, plan: await planForUser(user.id) };
}

type Authed = Request & { eligibility?: Eligibility };

function sendError(res: Response, err: unknown) {
  if (res.headersSent) return;
  if (err instanceof CloneError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  } else if (err instanceof ServiceUnavailableError) {
    log.error({ err }, 'voice clone service failure');
    res.status(503).json({ error: 'Voice cloning is temporarily unavailable. Try again later.', code: 'service_unavailable' });
  } else if (err instanceof multer.MulterError) {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${MAX_AUDIO_MB} MB).` : err.message, code: 'upload_error' });
  } else {
    log.error({ err }, 'voice clone error');
    res.status(500).json({ error: 'Something went wrong.', code: 'internal' });
  }
}

/** Async handler that maps CloneError / service errors to JSON responses. */
const h = (fn: (req: Authed, res: Response) => Promise<void>): RequestHandler => (req, res) => {
  fn(req as Authed, res).catch((e) => sendError(res, e));
};

const createSchema = z.object({
  challenge_id: z.string().uuid(),
  name: z.string().trim().min(1).max(100).default('My cloned voice'),
  language: z.string().trim().min(2).max(5).default('en'),
});

const abuseSchema = z.object({
  voice_id: z.string().uuid().optional(),
  contact: z.string().trim().min(3).max(200),
  category: z.enum(['impersonation', 'fraud', 'harassment', 'intimate_content', 'robocall', 'other']),
  details: z.string().trim().min(10).max(4000),
});

const uuid = z.string().uuid();

export function createVoiceClonesRouter(rd: VoiceClonesRouterDeps): Router {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 2, fields: 10 },
    fileFilter: (_req, file, cb) => cb(null, ALLOWED_MIMES.has(file.mimetype)),
  });

  const burst = rateLimit({
    windowMs: 3600_000, max: 20, standardHeaders: true, legacyHeaders: false, validate: false,
    keyGenerator: (req) => `voice-clone-burst:${(req as Authed).eligibility?.userId ?? req.ip}`,
    message: { error: 'Too many requests. Try again later.', code: 'rate_limited' },
  });

  // Public intake first: no sign-in needed to report abuse.
  r.post('/abuse-reports',
    rateLimit({ windowMs: 3600_000, max: 5, standardHeaders: true, legacyHeaders: false, validate: false, message: { error: 'Too many reports from this address. Email abuse@readaloudai.org.' } }),
    express.json({ limit: '16kb' }),
    h(async (req, res) => {
      const parsed = abuseSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid report.', code: 'validation', details: parsed.error.flatten().fieldErrors }); return; }
      const deps = rd.getDeps();
      if (!deps) { res.status(503).json({ error: 'Report intake unavailable. Email abuse@readaloudai.org.', code: 'unavailable' }); return; }
      const id = randomUUID();
      await deps.store.insertAbuseReport({ id, voiceId: parsed.data.voice_id ?? null, reporterContact: parsed.data.contact, category: parsed.data.category, details: parsed.data.details, createdAt: new Date().toISOString() });
      res.status(202).json({ id, status: 'received' });
    }));

  // Everything below needs the feature configured and a signed-in user. The dark check comes first so an
  // unconfigured deployment reveals nothing and never calls Supabase auth.
  r.use((_req, res, next) => {
    if (!rd.getDeps()) { res.status(503).json({ error: 'Voice cloning is not available.', code: 'unavailable' }); return; }
    next();
  });
  r.use((req, res, next) => {
    rd.resolveEligibility(req).then((e) => {
      if (!e) { res.status(401).json({ error: 'Sign in required.', code: 'unauthenticated' }); return; }
      (req as Authed).eligibility = e;
      next();
    }).catch((err) => sendError(res, err));
  });

  r.post('/consent-challenges', burst, h(async (req, res) => {
    const c = await issueConsentChallenge(rd.getDeps()!, req.eligibility!);
    res.status(201).json({ challenge_id: c.challengeId, phrase: c.phrase, expires_at: c.expiresAt });
  }));

  r.post('/', burst, upload.fields([{ name: 'consent', maxCount: 1 }, { name: 'reference', maxCount: 1 }]), h(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const consent = files?.consent?.[0];
    const reference = files?.reference?.[0];
    if (!consent || !reference || consent.size < 1024 || reference.size < 1024) {
      res.status(400).json({ error: 'Both a consent recording and a reference recording are required (WAV, FLAC, OGG, MP3, M4A or WebM).', code: 'audio_required' });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request.', code: 'validation', details: parsed.error.flatten().fieldErrors }); return; }
    const { voice, borderline } = await createVoiceClone(rd.getDeps()!, {
      eligibility: req.eligibility!,
      name: parsed.data.name,
      language: parsed.data.language.toLowerCase(),
      challengeId: parsed.data.challenge_id,
      consent: { audio: consent.buffer, mime: consent.mimetype },
      reference: { audio: reference.buffer, mime: reference.mimetype, filename: reference.originalname || 'reference' },
    });
    // `borderline` is for the operator (stored with the consent record); not exposed to the caller.
    if (borderline) log.info({ voiceId: voice.id, userId: voice.userId }, 'voice clone accepted within the borderline similarity margin');
    res.status(201).json({ id: voice.id, name: voice.name, language: voice.language, status: voice.status, reference_seconds: voice.referenceSec, model: voice.modelId, created_at: voice.createdAt });
  }));

  r.get('/', h(async (req, res) => {
    const voices = await rd.getDeps()!.store.listVoices(req.eligibility!.userId);
    res.json({ voices: voices.map((v) => ({ id: v.id, name: v.name, language: v.language, status: v.status, created_at: v.createdAt })) });
  }));

  r.delete('/:id', h(async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) { res.status(400).json({ error: 'Invalid voice id.', code: 'validation' }); return; }
    const out = await deleteVoiceClone(rd.getDeps()!, req.eligibility!.userId, id.data);
    res.json(out);
  }));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, err));
  return r;
}

export function createVoiceCloneAdminRouter(rd: Pick<VoiceClonesRouterDeps, 'getDeps' | 'adminKey'>): Router {
  const r = Router();
  r.use((req, res, next) => {
    // Unlike routes/admin.ts there is no built-in default key: an unset ADMIN_API_KEY disables this router.
    const expected = (rd.adminKey ?? (() => process.env.ADMIN_API_KEY))();
    const given = String(req.headers['x-admin-key'] ?? '');
    const ok = !!expected && expected !== 'listenai-admin-key-change-me' && given.length === expected.length
      && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (!rd.getDeps()) { res.status(503).json({ error: 'Voice cloning is not configured.', code: 'unavailable' }); return; }
    next();
  });
  r.post('/purge-expired', express.json(), h(async (_req, res) => {
    const d = rd.getDeps()!;
    res.json(await purgeExpired({ store: d.store, blobs: d.blobs, now: d.now }));
  }));
  r.post('/:id/disable', express.json({ limit: '8kb' }), h(async (req, res) => {
    const id = uuid.safeParse(req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!id.success || !reason) { res.status(400).json({ error: 'A valid voice id and a reason are required.', code: 'validation' }); return; }
    res.json(await disableVoiceClone(rd.getDeps()!, id.data, reason));
  }));
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, err));
  return r;
}

export const voiceClonesRouter = createVoiceClonesRouter({ getDeps: () => getCloneDeps(), resolveEligibility: resolveEligibilityFromSupabase });
export const voiceCloneAdminRouter = createVoiceCloneAdminRouter({ getDeps: () => getCloneDeps() });
