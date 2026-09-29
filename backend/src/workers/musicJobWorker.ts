import { claimNextMusicJob, updateMusicJobStatus, uploadMusicAudio, DBMusicJob, supabase } from '../lib/supabaseClient.js';
import { generateMusicAudioPath } from '../lib/cacheKey.js';
import { logger } from '../lib/logger.js';
import { reportMusicGenerationUsage } from '../lib/realtimeTtsBilling.js';

const workerLogger = logger.child({ module: 'music-worker' });

const MUSIC_WORKER_URL = process.env.MUSIC_WORKER_URL ?? '';
const MUSIC_WORKER_SHARED_SECRET = process.env.MUSIC_WORKER_SHARED_SECRET ?? '';
const POLL_INTERVAL_MS = 3000;
const STUCK_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_JOB_CHECK_INTERVAL_MS = 60 * 1000;

async function callModalWorker(prompt: string, durationSec: number): Promise<Buffer> {
  const response = await fetch(`${MUSIC_WORKER_URL}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MUSIC_WORKER_SHARED_SECRET}`,
    },
    body: JSON.stringify({ prompt, duration_sec: durationSec }),
    signal: AbortSignal.timeout(120_000), // generation shouldn't take longer than this; avoids a hung job forever
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Modal worker returned ${response.status}: ${body}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export interface MusicWorkerDeps {
  claimJob: () => Promise<DBMusicJob | null>;
  updateStatus: typeof updateMusicJobStatus;
  uploadAudio: typeof uploadMusicAudio;
  callModalWorker: (prompt: string, durationSec: number) => Promise<Buffer>;
}

const defaultDeps: MusicWorkerDeps = {
  claimJob: claimNextMusicJob,
  updateStatus: updateMusicJobStatus,
  uploadAudio: uploadMusicAudio,
  callModalWorker,
};

export async function processOneJob(deps: MusicWorkerDeps = defaultDeps): Promise<boolean> {
  const job = await deps.claimJob();
  if (!job) {
    return false;
  }

  workerLogger.info({ jobId: job.id }, 'Processing music job');

  try {
    const audioBuffer = await deps.callModalWorker(job.prompt, job.duration_sec);
    const audioPath = generateMusicAudioPath(job.id);
    await deps.uploadAudio(audioPath, audioBuffer);
    await deps.updateStatus(job.id, 'ready', { audioPath });
    workerLogger.info({ jobId: job.id, audioPath }, 'Music job ready');
    await reportMusicGenerationUsage(job.user_id).catch((err) => {
      workerLogger.error({ err, jobId: job.id }, 'Failed to report usage after successful job');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    workerLogger.error({ jobId: job.id, error: message }, 'Music job failed');
    await deps.updateStatus(job.id, 'failed', { errorCode: 'GENERATION_FAILED', errorMessage: message });
  }

  return true;
}

// Stuck-job reaper: mirrors ttsJobWorker.ts's checkForStuckJobs, simplified
// since music_jobs has no retry_count/chunking to reason about — a job
// stuck in 'processing' for more than STUCK_JOB_TIMEOUT_MS is just marked
// failed with a clear error code so it stops blocking polling clients
// forever (e.g. a worker crash mid-job, or a hung/unresponsive Modal call
// that somehow evaded the callModalWorker AbortSignal timeout).
export async function checkForStuckMusicJobs(): Promise<void> {
  const cutoffTime = new Date(Date.now() - STUCK_JOB_TIMEOUT_MS).toISOString();

  const { data: stuckJobs, error } = await supabase
    .from('music_jobs')
    .select('id')
    .eq('status', 'processing')
    .lt('updated_at', cutoffTime);

  if (error) {
    workerLogger.error({ error }, 'Failed to check for stuck music jobs');
    return;
  }

  for (const job of stuckJobs || []) {
    workerLogger.warn({ jobId: job.id }, 'Reaping stuck music job');
    await updateMusicJobStatus(job.id, 'failed', {
      errorCode: 'STUCK_JOB',
      errorMessage: `Job stuck in processing for over ${STUCK_JOB_TIMEOUT_MS / 1000}s`,
    }).catch((err) => {
      workerLogger.error({ err, jobId: job.id }, 'Failed to mark stuck music job as failed');
    });
  }
}

let pollInterval: NodeJS.Timeout | null = null;
let stuckJobInterval: NodeJS.Timeout | null = null;
let jobInFlight = false;

export function startMusicJobWorker(intervalMs: number = POLL_INTERVAL_MS): void {
  pollInterval = setInterval(() => {
    // Concurrency guard: skip this tick if the previous processOneJob() call
    // (from a prior tick) hasn't finished yet. Without this, a slow Modal
    // call (up to 120s, see callModalWorker's AbortSignal.timeout) combined
    // with a 3s poll interval would let dozens of overlapping processOneJob
    // calls race to claim jobs concurrently.
    if (jobInFlight) {
      return;
    }
    jobInFlight = true;
    processOneJob()
      .catch((err) => {
        workerLogger.error({ err }, 'Unexpected error in music job worker poll loop');
      })
      .finally(() => {
        jobInFlight = false;
      });
  }, intervalMs);

  stuckJobInterval = setInterval(() => {
    checkForStuckMusicJobs().catch((err) => {
      workerLogger.error({ err }, 'Unexpected error in music stuck-job reaper');
    });
  }, STUCK_JOB_CHECK_INTERVAL_MS);

  workerLogger.info({ intervalMs }, 'Music job worker started');
}

export function stopMusicJobWorker(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (stuckJobInterval) {
    clearInterval(stuckJobInterval);
    stuckJobInterval = null;
  }
}
