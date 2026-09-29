import { claimNextMusicJob, updateMusicJobStatus, uploadMusicAudio, DBMusicJob } from '../lib/supabaseClient.js';
import { generateMusicAudioPath } from '../lib/cacheKey.js';
import { logger } from '../lib/logger.js';
import { reportMusicGenerationUsage } from '../lib/realtimeTtsBilling.js';

const workerLogger = logger.child({ module: 'music-worker' });

const MUSIC_WORKER_URL = process.env.MUSIC_WORKER_URL ?? '';
const MUSIC_WORKER_SHARED_SECRET = process.env.MUSIC_WORKER_SHARED_SECRET ?? '';
const POLL_INTERVAL_MS = 3000;

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

export function startMusicJobWorker(intervalMs: number = POLL_INTERVAL_MS): void {
  setInterval(() => {
    processOneJob().catch((err) => {
      workerLogger.error({ err }, 'Unexpected error in music job worker poll loop');
    });
  }, intervalMs);
  workerLogger.info({ intervalMs }, 'Music job worker started');
}
