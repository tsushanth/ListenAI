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
  jobGroups.clear();
  jobToGroup.clear();
}

// ============================================================================
// Job Groups (Audiobooks MVP)
// ============================================================================
// A "job group" is a set of tts_jobs that belong together as one logical
// unit — for the Audiobooks MVP, one group per audiobook, one member job per
// chapter. This cache only tracks *membership* (groupId <-> jobIds); the
// per-job progress itself still lives in `progressCache` above (or the DB,
// once a job leaves this in-memory cache), so a group's aggregate status is
// always computed by looking up each member job the same way a single-job
// status poll already does — this just avoids every caller having to
// separately track "which jobIds make up audiobook X".
//
// Like `progressCache`, this is in-memory and per-instance. On horizontal
// scaling, move it to Redis (or drop it entirely and let callers query the
// `audiobook_chapters` table directly, which already mirrors job status) —
// see the same note on `progressCache` above.

const jobGroups = new Map<string, Set<string>>(); // groupId -> jobIds
const jobToGroup = new Map<string, string>(); // jobId -> groupId

/**
 * Register a tts_jobs id as a member of a job group (e.g. an audiobook id).
 * Safe to call before or after the job's own progress is initialized.
 */
export function addJobToGroup(groupId: string, jobId: string): void {
  let members = jobGroups.get(groupId);
  if (!members) {
    members = new Set();
    jobGroups.set(groupId, members);
  }
  members.add(jobId);
  jobToGroup.set(jobId, groupId);
}

/** Get all job ids registered under a group, or an empty array if none. */
export function getJobGroupMembers(groupId: string): string[] {
  const members = jobGroups.get(groupId);
  return members ? Array.from(members) : [];
}

/** Get the group a job belongs to, if any. */
export function getJobGroupForJob(jobId: string): string | null {
  return jobToGroup.get(jobId) ?? null;
}

/**
 * Remove a whole group's membership tracking (call once the group's
 * aggregate status is terminal, e.g. all chapters ready/failed, and callers
 * no longer need fast in-memory rollups).
 */
export function clearJobGroup(groupId: string): void {
  const members = jobGroups.get(groupId);
  if (members) {
    for (const jobId of members) jobToGroup.delete(jobId);
  }
  jobGroups.delete(groupId);
}

/**
 * Aggregate progress across a group's member jobs using whatever is
 * available in this in-memory cache right now. Jobs not present here have
 * either completed (and left the cache) or never started — callers should
 * treat a job missing from this aggregate as "check the DB" for that job,
 * exactly like the single-job status endpoint does.
 */
export function getJobGroupProgress(groupId: string): {
  totalKnown: number;
  chunksCompletedTotal: number;
  chunksTotalKnown: number;
  progressSecTotal: number;
  estimatedDurationSecTotal: number;
  anyPartialReady: boolean;
} {
  const members = getJobGroupMembers(groupId);
  let chunksCompletedTotal = 0;
  let chunksTotalKnown = 0;
  let progressSecTotal = 0;
  let estimatedDurationSecTotal = 0;
  let anyPartialReady = false;
  let totalKnown = 0;

  for (const jobId of members) {
    const progress = progressCache.get(jobId);
    if (!progress) continue;
    totalKnown++;
    chunksCompletedTotal += progress.chunksCompleted;
    chunksTotalKnown += progress.chunksTotal;
    progressSecTotal += progress.progressSec;
    estimatedDurationSecTotal += progress.estimatedDurationSec;
    if (progress.status === 'partial_ready') anyPartialReady = true;
  }

  return {
    totalKnown,
    chunksCompletedTotal,
    chunksTotalKnown,
    progressSecTotal,
    estimatedDurationSecTotal,
    anyPartialReady,
  };
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
