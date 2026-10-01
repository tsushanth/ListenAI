// Measured Modal usage per job, in shadow mode: it is recorded so it can be compared with Modal's own bill before
// anyone is charged on the new basis. Nothing here bills a user.
//
// Workers report the GPU seconds they spent (gpu_seconds in convert/isolate job status, X-GPU-Seconds for sound
// effects). The database function record_modal_usage() inserts the event and adds to the deployment's running total
// in one step and is idempotent per (service, job_id), so re-polling a finished job cannot count it twice.
import { logger } from './logger.js';
import { supabase } from './supabaseClient.js';
import type { DeploymentService } from './modalDeployments.js';

const log = logger.child({ module: 'modalUsage' });

export interface UsageEventInput {
  deploymentId: string | null;
  userId: string;
  service: DeploymentService;
  /** Stable id of the unit of work (the Modal job id, or our job row id). Re-reporting the same one is a no-op. */
  jobId: string;
  gpuSeconds: number;
}

export interface UsageRecorder {
  /** True when newly recorded, false when this (service, jobId) was already recorded. */
  record(ev: UsageEventInput): Promise<boolean>;
}

export function createSupabaseUsageRecorder(client = supabase): UsageRecorder {
  return {
    async record(ev) {
      const { data, error } = await client.rpc('record_modal_usage', {
        p_deployment_id: ev.deploymentId,
        p_user_id: ev.userId,
        p_service: ev.service,
        p_job_id: ev.jobId,
        p_gpu_seconds: ev.gpuSeconds,
      });
      if (error) throw new Error(`record_modal_usage: ${error.message}`);
      return data === true;
    },
  };
}

let recorder: UsageRecorder | null = null;

function getRecorder(): UsageRecorder {
  return (recorder ??= createSupabaseUsageRecorder());
}

/** Tests inject a fake recorder; pass null to reset. */
export function setUsageRecorderForTests(r: UsageRecorder | null): void {
  recorder = r;
}

/**
 * Record one job's measured GPU time. Never throws and never blocks the job: a usage record that fails is logged and
 * dropped, because losing a measurement must not fail a user's finished work.
 */
export async function recordModalUsage(ev: UsageEventInput, r: UsageRecorder = getRecorder()): Promise<boolean> {
  if (!Number.isFinite(ev.gpuSeconds) || ev.gpuSeconds < 0 || !ev.jobId || !ev.userId) {
    log.warn({ service: ev.service, jobId: ev.jobId, gpuSeconds: ev.gpuSeconds }, 'skipping usage record with invalid values');
    return false;
  }
  try {
    return await r.record({ ...ev, gpuSeconds: Math.round(ev.gpuSeconds * 1000) / 1000 });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), service: ev.service, jobId: ev.jobId }, 'failed to record modal usage (non-critical)');
    return false;
  }
}
