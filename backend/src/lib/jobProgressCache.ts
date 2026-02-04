/**
 * In-memory cache for TTS job progress tracking.
 *
 * This cache provides fast reads for polling clients without hitting the database.
 * Workers write to this cache as they process chunks, and clean up when done.
 *
 * GET /job/:id reads from cache first, falls back to DB if not found
 * (meaning job is either complete or was never started).
 *
 * For horizontal scaling with multiple Cloud Run instances, replace this
 * with Redis (Memorystore) - the interface stays the same.
 */

import pino from 'pino';

const logger = pino({ name: 'job-progress-cache' });

// Job progress stored in cache while processing
export interface JobProgress {
  status: 'processing' | 'partial_ready';
  chunksTotal: number;
  chunksCompleted: number;
  progressSec: number;           // Audio seconds synthesized so far
  estimatedDurationSec: number;  // Total estimated audio duration
  previewUrl?: string;           // Signed URL for preview audio (after first chunk)
  previewDurationSec?: number;   // Duration of preview audio
  startedAt: number;             // Unix timestamp for timeout detection
  voiceId?: string;              // Voice being used
  articleId?: string;            // Associated article (for client reference)
}

// In-memory store (replace with Redis for multi-instance deployment)
const progressCache = new Map<string, JobProgress>();

// Cache statistics for monitoring
let cacheStats = {
  hits: 0,
  misses: 0,
  writes: 0,
  deletes: 0,
};

/**
 * Initialize job progress when worker starts processing.
 */
export function initJobProgress(
  jobId: string,
  chunksTotal: number,
  estimatedDurationSec: number,
  options?: {
    voiceId?: string;
    articleId?: string;
  }
): void {
  const progress: JobProgress = {
    status: 'processing',
    chunksTotal,
    chunksCompleted: 0,
    progressSec: 0,
    estimatedDurationSec,
    startedAt: Date.now(),
    voiceId: options?.voiceId,
    articleId: options?.articleId,
  };

  progressCache.set(jobId, progress);
  cacheStats.writes++;

  logger.info({ jobId, chunksTotal, estimatedDurationSec }, 'Job progress initialized in cache');
}

/**
 * Update progress after a chunk is synthesized.
 */
export function updateChunkProgress(
  jobId: string,
  chunkDurationSec: number
): JobProgress | null {
  const progress = progressCache.get(jobId);
  if (!progress) {
    logger.warn({ jobId }, 'Attempted to update progress for job not in cache');
    return null;
  }

  progress.chunksCompleted++;
  progress.progressSec += chunkDurationSec;
  cacheStats.writes++;

  logger.debug({
    jobId,
    chunksCompleted: progress.chunksCompleted,
    chunksTotal: progress.chunksTotal,
    progressSec: progress.progressSec,
  }, 'Chunk progress updated');

  return progress;
}

/**
 * Set preview URL after first chunk is uploaded.
 */
export function setPreviewReady(
  jobId: string,
  previewUrl: string,
  previewDurationSec: number
): JobProgress | null {
  const progress = progressCache.get(jobId);
  if (!progress) {
    logger.warn({ jobId }, 'Attempted to set preview for job not in cache');
    return null;
  }

  progress.status = 'partial_ready';
  progress.previewUrl = previewUrl;
  progress.previewDurationSec = previewDurationSec;
  cacheStats.writes++;

  logger.info({ jobId, previewDurationSec }, 'Preview ready, cache updated');

  return progress;
}

/**
 * Get job progress from cache.
 * Returns null if job is not in cache (either complete or never started).
 */
export function getJobProgress(jobId: string): JobProgress | null {
  const progress = progressCache.get(jobId);

  if (progress) {
    cacheStats.hits++;
  } else {
    cacheStats.misses++;
  }

  return progress || null;
}

/**
 * Check if job exists in cache.
 */
export function isJobInCache(jobId: string): boolean {
  return progressCache.has(jobId);
}

/**
 * Remove job from cache when processing is complete.
 * Call this after uploading final audio and updating DB.
 */
export function clearJobProgress(jobId: string): void {
  const existed = progressCache.delete(jobId);

  if (existed) {
    cacheStats.deletes++;
    logger.info({ jobId }, 'Job progress cleared from cache');
  }
}

/**
 * Get all jobs currently in cache (for monitoring/debugging).
 */
export function getAllActiveJobs(): Map<string, JobProgress> {
  return new Map(progressCache);
}

/**
 * Get count of active jobs in cache.
 */
export function getActiveJobCount(): number {
  return progressCache.size;
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats(): typeof cacheStats & { activeJobs: number } {
  return {
    ...cacheStats,
    activeJobs: progressCache.size,
  };
}

/**
 * Check for and clean up stale jobs that have been in cache too long.
 * Returns list of job IDs that were cleaned up.
 */
export function cleanupStaleJobs(maxAgeMs: number = 15 * 60 * 1000): string[] {
  const now = Date.now();
  const staleJobIds: string[] = [];

  for (const [jobId, progress] of progressCache) {
    const age = now - progress.startedAt;
    if (age > maxAgeMs) {
      staleJobIds.push(jobId);
      progressCache.delete(jobId);
      cacheStats.deletes++;

      logger.warn({
        jobId,
        ageMs: age,
        chunksCompleted: progress.chunksCompleted,
        chunksTotal: progress.chunksTotal,
      }, 'Stale job removed from cache');
    }
  }

  return staleJobIds;
}

/**
 * Reset cache (for testing only).
 */
export function resetCache(): void {
  progressCache.clear();
  cacheStats = { hits: 0, misses: 0, writes: 0, deletes: 0 };
}

/**
 * Calculate percentage complete for a job.
 */
export function calculatePercentage(progress: JobProgress): number {
  if (progress.estimatedDurationSec <= 0) {
    // Fall back to chunk-based if no duration estimate
    if (progress.chunksTotal <= 0) return 0;
    return Math.round((progress.chunksCompleted / progress.chunksTotal) * 100);
  }
  return Math.min(99, Math.round((progress.progressSec / progress.estimatedDurationSec) * 100));
}

/**
 * Calculate estimated remaining time in seconds.
 */
export function calculateEstimatedRemaining(progress: JobProgress): number | null {
  if (progress.chunksCompleted === 0 || progress.progressSec === 0) {
    return null; // Can't estimate yet
  }

  const elapsedMs = Date.now() - progress.startedAt;
  const elapsedSec = elapsedMs / 1000;

  // Rate = audio seconds generated per wall-clock second
  const rate = progress.progressSec / elapsedSec;

  if (rate <= 0) return null;

  const remainingAudioSec = progress.estimatedDurationSec - progress.progressSec;
  const estimatedRemainingSec = Math.round(remainingAudioSec / rate);

  return Math.max(0, estimatedRemainingSec);
}
