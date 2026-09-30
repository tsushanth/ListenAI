// Text-to-sound-effect API routes. Mirrors the (unmerged) text-to-music
// feature branch's routes/textToMusic.ts 1:1 in shape (async job API,
// cache-hit handling, zod validation) — adapted for sound effects'
// much-shorter duration range.
//
// Auth: mounted behind `requireAuthOrApiKey` in index.ts (see
// middleware/apiKeyAuth.ts and MCP_AUTH_BRIDGE.md), NOT `requireAuth`. This
// route used to be mounted behind `requireAuth`, whose default-user fallback
// would silently resolve any missing/invalid/dev-mode credential to a shared
// default UUID — actively dangerous for a billed, MCP-reachable route like
// this one (an unauthenticated caller could get billed to a shared default
// user). `requireAuthOrApiKey` has no such fallback: it accepts a real
// Supabase JWT or a gateway-forwarded API-key identity, and 401s everything
// else. It also sets `req.userId` (as read below), which the actual
// `requireAuth` middleware never set — so swapping it in also fixes a
// latent bug where `userId` would have been `undefined` on every request.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, NotFoundError } from '../types/index.js';
import { computeSoundEffectCacheKey } from '../lib/cacheKey.js';
import {
  createSoundEffectJob,
  getSoundEffectJobForUser,
  getCachedSoundEffect,
  getSignedAudioUrl,
} from '../lib/supabaseClient.js';
import { hasUsageAllowance, freeCreditsExhaustedMessage } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';

const soundEffectsLogger = logger.child({ module: 'sound-effects' });

// Sound effects are almost always much shorter than music generations —
// UI stingers, foley, one-shot effects. 1s covers a single short hit (a
// click, a footstep); music's 15s floor makes no sense for that. The
// ceiling (12s) is well under Stable Audio Open 1.0's own hard cap of
// ~47.5s (sample_size=2097152 at sample_rate=44100 — same constant the
// music branch's textToMusic.ts documents and that
// backend/modal/sound_effects_worker.py's MAX_DURATION_SEC must match) —
// a caller wanting a longer ambience-style clip should use the music
// endpoint instead. Both bounds are a judgment call, not a hard product
// spec; flagged in the top-level report.
const MIN_DURATION_SEC = 1;
const MAX_DURATION_SEC = 12;

const jobRequestSchema = z.object({
  prompt: z.string().min(1).max(500),
  duration_sec: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC),
});

interface StrictAuthedRequest extends Request {
  userId?: string;
}

export const soundEffectsRouter = Router();

soundEffectsRouter.post('/job', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;

  const parseResult = jobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }
  const { prompt, duration_sec } = parseResult.data;

  const cacheKey = computeSoundEffectCacheKey({ prompt, durationSec: duration_sec });

  const cached = await getCachedSoundEffect(cacheKey);
  if (cached?.audio_path) {
    const audioUrl = await getSignedAudioUrl(cached.audio_path);
    if (audioUrl) {
      soundEffectsLogger.info({ cacheKey }, 'Sound effect cache hit');
      // DECISION: cache hits are NOT billed. No new GPU work happened — the
      // audio was already generated (and billed) for whichever user
      // triggered the original generation — so charging this user again
      // for a cache hit would be double-billing for zero marginal cost.
      // Mirrors the same cache-hit pattern as textToMusic.ts / tts.ts.
      res.status(202).json({
        // Synthetic pseudo job id, not `cached.id` (the original
        // generating job's real id, which may belong to a different
        // user — returning it verbatim would make GET /job/:jobId 404 for
        // this user, since getSoundEffectJobForUser scopes by user_id).
        job_id: `cache-${cacheKey.substring(0, 8)}`,
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      });
      return;
    }
  }

  // Billing gate: mirrors voiceDesign.ts's requireUser check
  // (isBillingActiveForUser). Only applies past the cache-hit path above,
  // since cache hits aren't billed.
  const billingActive = await hasUsageAllowance(userId);
  if (!billingActive) {
    res.status(402).json({ error: freeCreditsExhaustedMessage('sound effects') });
    return;
  }

  const job = await createSoundEffectJob({ userId, prompt, durationSec: duration_sec, cacheKey });
  soundEffectsLogger.info({ jobId: job.id, cacheKey }, 'Sound effect job created');

  res.status(202).json({
    job_id: job.id,
    status: 'processing',
    cache_hit: false,
    estimated_wait_sec: Math.ceil(duration_sec / 4), // rough: generation runs faster than realtime on GPU
  });
}));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

soundEffectsRouter.get('/job/:jobId', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;
  const jobId = req.params.jobId!;

  // Cache-hit pseudo-ids (see POST /job) are always "ready" and never hit
  // the DB. The real audio_url was already returned in the original POST
  // response, so a client polling a cache-hit id afterward should already
  // have it and doesn't need to poll at all — no audio_url is included here
  // since an 8-char cache-key prefix can't reconstruct or re-sign it.
  if (jobId.startsWith('cache-')) {
    res.json({
      job_id: jobId,
      status: 'ready',
      error: undefined,
    });
    return;
  }

  // Reject anything that isn't a real UUID before hitting Postgres — the
  // RPC's UUID-typed parameter would otherwise turn a malformed id into an
  // unhandled 500 instead of a normal 404.
  if (!UUID_REGEX.test(jobId)) {
    throw new NotFoundError('Job');
  }

  const job = await getSoundEffectJobForUser(jobId, userId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  let audioUrl: string | undefined;
  if (job.status === 'ready' && job.audio_path) {
    audioUrl = (await getSignedAudioUrl(job.audio_path)) ?? undefined;
  }

  // Don't echo the raw upstream (Modal worker) error body back to external
  // API callers — it may contain internal stack traces, hostnames, or other
  // implementation detail we don't want to leak. The detailed message is
  // still stored in job.error_message in the DB for our own debugging (see
  // soundEffectJobWorker.ts) and logged server-side; only a generic message
  // goes in the HTTP response.
  res.json({
    job_id: job.id,
    status: job.status,
    audio_url: audioUrl,
    error: job.error_code ? { code: job.error_code, message: 'Sound effect generation failed' } : undefined,
  });
}));
