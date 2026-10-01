// Text-to-music API routes.
//
// Auth: mounted behind `requireMusicAuth` (see index.ts), which accepts a
// persistent rlm_ API key or a Supabase session token. Key minting lives in
// routes/musicApiKeys.ts behind session-only requireRealAuth.
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, NotFoundError } from '../types/index.js';
import { computeMusicCacheKey } from '../lib/cacheKey.js';
import {
  createMusicJob,
  getMusicJobForUser,
  getCachedMusic,
  getSignedAudioUrl,
} from '../lib/supabaseClient.js';
import { isBillingActiveForUser } from '../lib/realtimeTtsBilling.js';
import { logger } from '../lib/logger.js';
import { getDeploymentManager } from '../lib/modalDeployments.js';
import { mountDeploymentRoutes } from './deployments.js';

const musicLogger = logger.child({ module: 'text-to-music' });

const MIN_DURATION_SEC = 15;
// Stable Audio Open 1.0's model config caps generation at ~47.5s
// (sample_size=2097152 at sample_rate=44100) — confirmed via an actual
// end-to-end training + inference run. Must match worker-modal-music/app.py's
// MAX_DURATION_SEC in the realtime-tts repo.
const MAX_DURATION_SEC = 47;

// Fail-closed provisioning gate. Music generation runs on our own paid GPU
// (Modal A10G) and is only revenue-bearing if BOTH (a) the worker is enabled
// and (b) MUSIC_GENERATION_PRICE_ID is set, so checkout attaches the metered
// per-generation price. Without (b), reportMusicGenerationUsage emits meter
// events that bill nothing (unpriced GPU cost). Read at request time so the
// gate follows the deployed env; new job creation is refused (503) unless
// both are set. Not applied to GET /job/:jobId so in-flight jobs stay pollable.
export function isMusicProvisioned(): boolean {
  return process.env.MUSIC_WORKER_ENABLED === 'true' && !!process.env.MUSIC_GENERATION_PRICE_ID;
}

const jobRequestSchema = z.object({
  prompt: z.string().min(1).max(500),
  duration_sec: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC),
});

interface StrictAuthedRequest extends Request {
  userId?: string;
}

export const textToMusicRouter = Router();

// requireMusicAuth (mounted in front of this router in index.ts) has already resolved req.userId, from a session token
// or a persistent API key; a request that reaches here without one must not proceed.
function requireUserId(req: Request, res: Response, next: NextFunction) {
  if (!(req as StrictAuthedRequest).userId) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  next();
}

// Self-serve lifecycle: POST/GET/DELETE /deploy brings up, reports on, and tears down the caller's own Modal app.
// A deploy is refused unless music is provisioned (worker enabled AND a billing price configured): starting GPU
// resources for a feature that cannot earn its cost is the exact thing that gate exists to prevent.
mountDeploymentRoutes(textToMusicRouter, 'music', requireUserId, {
  precondition: () => (isMusicProvisioned() ? null : 'Text-to-music is not available.'),
});

textToMusicRouter.post('/job', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;

  if (!isMusicProvisioned()) {
    res.status(503).json({ error: 'Text-to-music is not available.' });
    return;
  }

  const parseResult = jobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }
  const { prompt, duration_sec } = parseResult.data;

  // Billing gate: mirrors voiceDesign.ts's requireUser check (isBillingActiveForUser).
  // Runs BEFORE the cache lookup below: a cache hit costs no new GPU work,
  // but it's still someone else's generated audio — a user with no active
  // subscription must not get it for free just because another user already
  // paid to generate it once. Billing gates access to the feature, not just
  // to fresh generation.
  const billingActive = await isBillingActiveForUser(userId);
  if (!billingActive) {
    res.status(402).json({ error: 'Text-to-music requires an active TTS subscription.' });
    return;
  }

  const cacheKey = computeMusicCacheKey({ prompt, durationSec: duration_sec });

  const cached = await getCachedMusic(cacheKey);
  if (cached?.audio_path) {
    const audioUrl = await getSignedAudioUrl(cached.audio_path);
    if (audioUrl) {
      musicLogger.info({ cacheKey }, 'Music cache hit');
      // DECISION: cache hits are NOT metered/billed per-generation. No new
      // GPU work happened — the audio was already generated (and billed)
      // for whichever user triggered the original generation — so charging
      // this user a second per-generation fee for a cache hit would be
      // double-billing for zero marginal cost. The billing-active check
      // above still gates whether this user can use the feature at all.
      res.status(202).json({
        // Return a synthetic pseudo job id, not `cached.id` (the original
        // generating job's real id). That job may belong to a different
        // user, so returning it verbatim would make GET /job/:jobId 404 for
        // this user (getMusicJobForUser scopes by user_id). Mirrors the
        // same cache-hit pattern used for TTS jobs — see routes/tts.ts.
        job_id: `cache-${cacheKey.substring(0, 8)}`,
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      });
      return;
    }
  }

  // Generation runs on the caller's own Modal deployment (there is no shared worker). Cache hits above need none.
  const manager = getDeploymentManager();
  const target = await manager.resolveTarget(userId, 'music', { forNewWork: true });
  if (!target) {
    res.status(400).json({
      error: 'Text-to-music is not deployed. Deploy first (POST /api/music/deploy), wait until its status is "ready", then submit.',
      code: 'deployment_required',
    });
    return;
  }

  const job = await createMusicJob({ userId, prompt, durationSec: duration_sec, cacheKey });
  await manager.touch(target, { job: true }).catch((err) => musicLogger.warn({ err }, 'failed to record deployment activity (non-critical)'));
  musicLogger.info({ jobId: job.id, cacheKey }, 'Music job created');

  res.status(202).json({
    job_id: job.id,
    status: 'processing',
    cache_hit: false,
    estimated_wait_sec: Math.ceil(duration_sec / 4), // rough: generation runs faster than realtime on GPU
  });
}));

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

textToMusicRouter.get('/job/:jobId', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;
  const jobId = req.params.jobId!;

  // Cache-hit pseudo-ids (see POST /job) are always "ready" and never hit the
  // DB. The real audio_url was already returned in the original POST
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

  const job = await getMusicJobForUser(jobId, userId);
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
  // musicJobWorker.ts) and logged server-side; only a generic message goes
  // in the HTTP response.
  res.json({
    job_id: job.id,
    status: job.status,
    audio_url: audioUrl,
    error: job.error_code
      ? {
          code: job.error_code,
          message: job.error_code === 'DEPLOYMENT_REQUIRED'
            ? 'Your text-to-music deployment is not running. Deploy it again and resubmit.'
            : 'Music generation failed',
        }
      : undefined,
  });
}));
