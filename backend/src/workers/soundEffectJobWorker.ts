// Polling worker for sound-effect jobs: claim a job, call the OWNING USER's Modal deployment over HTTP with that
// deployment's own secret, upload the result, update status. There is no shared worker any more: each user deploys
// their own app (POST /api/sound-effects/deploy, lib/modalDeployments.ts). If the deployment is gone by the time a
// job is picked up, the job fails with DEPLOYMENT_REQUIRED and is not billed. Gated behind
// SOUND_EFFECT_WORKER_ENABLED (mirroring MUSIC_WORKER_ENABLED).
import { claimNextSoundEffectJob, updateSoundEffectJobStatus, uploadSoundEffectAudio, DBSoundEffectJob, supabase } from '../lib/supabaseClient.js';
import { generateSoundEffectAudioPath } from '../lib/cacheKey.js';
import { logger } from '../lib/logger.js';
import { reportSoundEffectGenerationUsage } from '../lib/realtimeTtsBilling.js';
import { getDeploymentManager } from '../lib/modalDeployments.js';
import { recordModalUsage } from '../lib/modalUsage.js';

const workerLogger = logger.child({ module: 'sound-effect-worker' });

const POLL_INTERVAL_MS = 3000;
const STUCK_JOB_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const STUCK_JOB_CHECK_INTERVAL_MS = 60 * 1000;

/** The job's owner has no ready deployment (never deployed, torn down, or idle/age expired). */
export class DeploymentRequiredError extends Error {
  constructor() {
    super('No active sound effects deployment for this user.');
    this.name = 'DeploymentRequiredError';
  }
}

export interface ModalResult {
  audio: Buffer;
  /** Seconds of GPU time the worker reports it spent on this request (X-GPU-Seconds), if it said. */
  gpuSeconds: number | null;
  /** The deployment that served the request, so its usage can be attributed. */
  deploymentId: string;
}

export async function callModalWorker(job: Pick<DBSoundEffectJob, 'user_id' | 'prompt' | 'duration_sec'>): Promise<ModalResult> {
  const manager = getDeploymentManager();
  const target = await manager.resolveTarget(job.user_id, 'sound_effect');
  if (!target) throw new DeploymentRequiredError();

  const response = await fetch(`${target.url}/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.secret}`,
    },
    body: JSON.stringify({ prompt: job.prompt, duration_sec: job.duration_sec }),
    signal: AbortSignal.timeout(120_000), // generation shouldn't take longer than this; avoids a hung job forever
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Modal worker returned ${response.status}: ${body}`);
  }

  // Activity: keep the deployment alive while a job is being served (throttled, not a write per call).
  await manager.touch(target).catch((err) => workerLogger.warn({ err }, 'failed to record deployment activity (non-critical)'));

  // Number(null) is 0, so check for a missing header first: "the worker did not say" must not read as "zero seconds".
  const header = response.headers.get('x-gpu-seconds');
  const gpu = header === null || header.trim() === '' ? NaN : Number(header);
  return {
    audio: Buffer.from(await response.arrayBuffer()),
    gpuSeconds: Number.isFinite(gpu) && gpu >= 0 ? gpu : null,
    deploymentId: target.deploymentId,
  };
}

export interface SoundEffectWorkerDeps {
  claimJob: () => Promise<DBSoundEffectJob | null>;
  updateStatus: typeof updateSoundEffectJobStatus;
  uploadAudio: typeof uploadSoundEffectAudio;
  callModalWorker: (job: Pick<DBSoundEffectJob, 'user_id' | 'prompt' | 'duration_sec'>) => Promise<ModalResult>;
}

const defaultDeps: SoundEffectWorkerDeps = {
  claimJob: claimNextSoundEffectJob,
  updateStatus: updateSoundEffectJobStatus,
  uploadAudio: uploadSoundEffectAudio,
  callModalWorker,
};

export async function processOneJob(deps: SoundEffectWorkerDeps = defaultDeps): Promise<boolean> {
  const job = await deps.claimJob();
  if (!job) {
    return false;
  }

  workerLogger.info({ jobId: job.id }, 'Processing sound effect job');

  try {
    const { audio: audioBuffer, gpuSeconds, deploymentId } = await deps.callModalWorker(job);
    const audioPath = generateSoundEffectAudioPath(job.id);
    await deps.uploadAudio(audioPath, audioBuffer);
    await deps.updateStatus(job.id, 'ready', { audioPath });
    workerLogger.info({ jobId: job.id, audioPath, gpuSeconds }, 'Sound effect job ready');
    // Shadow mode: record the measured GPU time. Not billed; compared against Modal's own bill (modalUsage.ts).
    if (gpuSeconds !== null) {
      await recordModalUsage({ deploymentId, userId: job.user_id, service: 'sound_effect', jobId: job.id, gpuSeconds });
    }
    // Billed per second of generated audio (rounded up, with a minimum), see AUDIO_JOB_PRICING.
    await reportSoundEffectGenerationUsage(job.user_id, job.duration_sec, job.id).catch((err) => {
      workerLogger.error({ err, jobId: job.id }, 'Failed to report usage after successful job');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const deploymentGone = err instanceof DeploymentRequiredError;
    workerLogger.error({ jobId: job.id, error: message }, deploymentGone ? 'Sound effect job failed: no deployment' : 'Sound effect job failed');
    await deps.updateStatus(job.id, 'failed', {
      errorCode: deploymentGone ? 'DEPLOYMENT_REQUIRED' : 'GENERATION_FAILED',
      errorMessage: message,
    });
  }

  return true;
}

// Stuck-job reaper: mirrors musicJobWorker.ts's checkForStuckMusicJobs,
// simplified since sound_effect_jobs has no retry_count/chunking to reason
// about — a job stuck in 'processing' for more than STUCK_JOB_TIMEOUT_MS is
// just marked failed with a clear error code so it stops blocking polling
// clients forever (e.g. a worker crash mid-job, or a hung/unresponsive
// Modal call that somehow evaded the callModalWorker AbortSignal timeout).
export async function checkForStuckSoundEffectJobs(): Promise<void> {
  const cutoffTime = new Date(Date.now() - STUCK_JOB_TIMEOUT_MS).toISOString();

  const { data: stuckJobs, error } = await supabase
    .from('sound_effect_jobs')
    .select('id')
    .eq('status', 'processing')
    .lt('updated_at', cutoffTime);

  if (error) {
    workerLogger.error({ error }, 'Failed to check for stuck sound effect jobs');
    return;
  }

  for (const job of stuckJobs || []) {
    workerLogger.warn({ jobId: job.id }, 'Reaping stuck sound effect job');
    await updateSoundEffectJobStatus(job.id, 'failed', {
      errorCode: 'STUCK_JOB',
      errorMessage: `Job stuck in processing for over ${STUCK_JOB_TIMEOUT_MS / 1000}s`,
    }).catch((err) => {
      workerLogger.error({ err, jobId: job.id }, 'Failed to mark stuck sound effect job as failed');
    });
  }
}

let pollInterval: NodeJS.Timeout | null = null;
let stuckJobInterval: NodeJS.Timeout | null = null;
let jobInFlight = false;

export function startSoundEffectJobWorker(intervalMs: number = POLL_INTERVAL_MS): void {
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
        workerLogger.error({ err }, 'Unexpected error in sound effect job worker poll loop');
      })
      .finally(() => {
        jobInFlight = false;
      });
  }, intervalMs);

  stuckJobInterval = setInterval(() => {
    checkForStuckSoundEffectJobs().catch((err) => {
      workerLogger.error({ err }, 'Unexpected error in sound effect stuck-job reaper');
    });
  }, STUCK_JOB_CHECK_INTERVAL_MS);

  workerLogger.info({ intervalMs }, 'Sound effect job worker started');
}

export function stopSoundEffectJobWorker(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (stuckJobInterval) {
    clearInterval(stuckJobInterval);
    stuckJobInterval = null;
  }
}
