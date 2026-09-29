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
      res.status(202).json({
        job_id: cached.id,
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      });
      return;
    }
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

textToMusicRouter.get('/job/:jobId', asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as StrictAuthedRequest).userId!;
  const jobId = req.params.jobId!;

  const job = await getMusicJobForUser(jobId, userId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  let audioUrl: string | undefined;
  if (job.status === 'ready' && job.audio_path) {
    audioUrl = (await getSignedAudioUrl(job.audio_path)) ?? undefined;
  }

  res.json({
    job_id: job.id,
    status: job.status,
    audio_url: audioUrl,
    error: job.error_code ? { code: job.error_code, message: job.error_message ?? 'Unknown error' } : undefined,
  });
}));
