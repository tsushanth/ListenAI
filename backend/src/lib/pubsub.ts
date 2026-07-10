import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';

// ============================================================================
// Job Queue — DB-only (post-GCP migration, 2026-05-25)
// ============================================================================
//
// This file used to be a GCP Pub/Sub client. After the move off GCP, the
// queue is now driven entirely by the `tts_jobs` table in Supabase:
//   - Job creation = INSERT row with status='queued'
//   - Job pickup = the worker's built-in DB poll (3s cadence in
//     `workers/ttsJobWorker.ts startWorker()`) SELECTs queued rows and
//     atomically claims them by flipping status='processing'
//   - Job retry = UPDATE row back to status='queued' with retry_count++
//
// The exports below preserve the old Pub/Sub-style public API so callers
// in routes/tts.ts and workers/ttsJobWorker.ts don't have to change.
// They're thin shims over the DB-only model.
//
// Filename is kept as pubsub.ts only to minimize the import churn. Treat
// this as the job queue module.

const queueLogger = logger.child({ module: 'jobQueue' });

// Job message payload — kept stable for callsite compatibility
export interface TTSJobMessage {
  jobId: string;
  attempt: number; // 1-based attempt number
  publishedAt: string;
}

export type MessageHandler = (message: TTSJobMessage) => Promise<void>;

/**
 * Publish a TTS job. With the DB-only queue, the row's existing
 * `status='queued'` IS the publish — the worker's polling loop picks it
 * up within ~3s. This function is a no-op kept for API stability.
 *
 * Returns the jobId in place of the old Pub/Sub message ID so any
 * caller that logs the return value keeps working.
 */
export async function publishTTSJob(jobId: string): Promise<string> {
  queueLogger.debug({ jobId }, 'Job queued (DB poll will pick up)');
  return jobId;
}

/**
 * Mark a job for retry. The caller (worker) is responsible for the
 * actual DB update — see `ttsJobWorker.ts` near the failure paths,
 * which sets `status='queued'` + `retry_count`. We just return
 * true/false to keep the original control flow.
 */
export async function republishForRetry(
  jobId: string,
  currentAttempt: number,
  maxRetries: number = 3
): Promise<boolean> {
  if (currentAttempt >= maxRetries) {
    queueLogger.warn(
      { jobId, currentAttempt, maxRetries },
      'Max retries reached, not requeuing'
    );
    return false;
  }
  queueLogger.info(
    { jobId, nextAttempt: currentAttempt + 1 },
    'Job will be requeued for retry (caller updates DB row)'
  );
  return true;
}

/**
 * Subscribe to job messages. The worker's own DB-polling loop in
 * `startWorker()` is now the only consumption path, so this is a no-op
 * that returns an empty stop function. Kept so existing call sites
 * compile and behave the same.
 */
export function startSubscription(_handler: MessageHandler): () => void {
  queueLogger.info('startSubscription: using DB poll (no external queue)');
  return () => {
    queueLogger.debug('stopSubscription: no-op (DB poll lives in worker)');
  };
}

/**
 * Health check. With Pub/Sub gone, "queue health" reduces to "can we
 * reach Supabase and read the jobs table?". Used by the /health route.
 */
export async function checkPubSubHealth(): Promise<boolean> {
  try {
    const { error } = await supabase.from('tts_jobs').select('id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

// Kept exported for any callsite that referenced these constants. Both
// now point at the table name — the queue and the table are one.
export const TOPIC_NAME = 'tts_jobs';
export const SUBSCRIPTION_NAME = 'tts_jobs';
