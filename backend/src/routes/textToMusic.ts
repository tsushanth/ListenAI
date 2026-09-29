// Text-to-music API routes.
//
// Auth: mounted behind `requireRealAuth` (see index.ts) which currently only
// accepts a Supabase user session/access token, verified remotely via
// verifyAuthTokenRemote (see routes/ttsApiKeys.ts). There is NOT yet a
// separate long-lived "API key" mechanism for this endpoint — an external
// SDK consumer must pass their ReadAloud Supabase access token in the
// Authorization header as their "API key". This is a real limitation for
// third-party integrations (tokens expire and aren't meant to be
// distributed as API keys) but is how auth on this endpoint actually works
// today.
// TODO: add persistent-API-key support for the text-to-music endpoint
// (mirroring however ttsApiKeys.ts's job-API-key flow works for TTS) — not
// yet implemented.
import { Router, Request, Response } from 'express';
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

const musicLogger = logger.child({ module: 'text-to-music' });

const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 120;

const jobRequestSchema = z.object({
  prompt: z.string().min(1).max(500),
  duration_sec: z.number().min(MIN_DURATION_SEC).max(MAX_DURATION_SEC),
});

interface StrictAuthedRequest extends Request {
  userId?: string;
}

export const textToMusicRouter = Router();

textToMusicRouter.post('/job', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;

  const parseResult = jobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }
  const { prompt, duration_sec } = parseResult.data;

  const cacheKey = computeMusicCacheKey({ prompt, durationSec: duration_sec });

  const cached = await getCachedMusic(cacheKey);
  if (cached?.audio_path) {
    const audioUrl = await getSignedAudioUrl(cached.audio_path);
    if (audioUrl) {
      musicLogger.info({ cacheKey }, 'Music cache hit');
      // DECISION: cache hits are NOT billed. No new GPU work happened — the
      // audio was already generated (and billed) for whichever user
      // triggered the original generation — so charging this user again
      // for a cache hit would be double-billing for zero marginal cost.
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

  // Billing gate: mirrors voiceDesign.ts's requireUser check (isBillingActiveForUser).
  // Only applies past the cache-hit path above, since cache hits aren't billed.
  const billingActive = await isBillingActiveForUser(userId);
  if (!billingActive) {
    res.status(402).json({ error: 'Text-to-music requires an active TTS subscription.' });
    return;
  }

  const job = await createMusicJob({ userId, prompt, durationSec: duration_sec, cacheKey });
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
    error: job.error_code ? { code: job.error_code, message: 'Music generation failed' } : undefined,
  });
}));
