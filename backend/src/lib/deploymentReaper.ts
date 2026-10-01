// Automatic teardown for self-serve Modal deployments (see modalDeployments.ts).
//
// Explicit teardown (DELETE /deploy) is not enough on its own: every app runs on our Modal bill, so a user
// who forgets, a crash, or a failed stop must not leave one running. Each pass:
//   1. fails and cleans up deployments stuck in requested/deploying (a backend restart mid-deploy),
//   2. tears down ready deployments that are idle or past their maximum age,
//   3. retries teardowns that did not finish,
//   4. cleans up failed deploys whose cleanup never completed,
//   5. deletes per-user Volumes once their retention window has passed,
//   6. (every Nth pass) stops orphaned apps: ones Modal reports as deployed that no live row owns.
// All state changes go through compare-and-set updates, so it is safe to run on several machines at once.
import { logger } from './logger.js';
import { reportFailure } from './failureReporter.js';
import {
  DeploymentManager,
  LIVE_STATUSES,
  managedAppPattern,
  type DeploymentRow,
} from './modalDeployments.js';

const log = logger.child({ module: 'deploymentReaper' });

export interface ReaperResult {
  stuckFailed: number;
  idleTornDown: number;
  expiredTornDown: number;
  teardownRetried: number;
  failedCleaned: number;
  volumesDeleted: number;
  orphansStopped: number;
}

const BATCH = 200;
const STOPPING_RETRY_AFTER_MS = 60_000;
export const MAX_ORPHAN_STOPS_PER_RUN = 5;

export async function runReaperOnce(manager: DeploymentManager, opts: { scanOrphans?: boolean } = {}): Promise<ReaperResult> {
  const { store, cli, limits } = manager;
  const nowMs = manager.now().getTime();
  const result: ReaperResult = {
    stuckFailed: 0, idleTornDown: 0, expiredTornDown: 0, teardownRetried: 0, failedCleaned: 0, volumesDeleted: 0, orphansStopped: 0,
  };

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      // One failing step must not stop the others: a store hiccup should not block orphan cleanup.
      log.error({ step: name, err: err instanceof Error ? err.message : String(err) }, 'reaper step failed');
    }
  };

  // 1. stuck deploys
  await step('stuck', async () => {
    for (const row of await store.listByStatus(['requested', 'deploying'], BATCH)) {
      const since = Date.parse(row.deploy_started_at ?? row.created_at);
      if (nowMs - since < limits.deployTimeoutMs) continue;
      const failed = await store.transition(row.id, ['requested', 'deploying'], {
        status: 'failed',
        error: 'Deployment did not finish in time and was cancelled.',
        stop_reason: 'deploy_timeout',
      });
      if (failed) {
        result.stuckFailed++;
        await manager.cleanup(failed);
      }
    }
  });

  // 2. idle and expired
  await step('ready', async () => {
    for (const row of await store.listByStatus(['ready'], BATCH)) {
      const expired = !!row.expires_at && Date.parse(row.expires_at) <= nowMs;
      const idle = !!row.last_used_at && Date.parse(row.last_used_at) + limits.idleTtlMs <= nowMs;
      if (!expired && !idle) continue;
      const out = await manager.teardown(row.id, expired ? 'max_age' : 'idle');
      if (out === 'noop') continue;
      if (expired) result.expiredTornDown++;
      else result.idleTornDown++;
    }
  });

  // 3. teardowns that did not finish
  await step('stopping', async () => {
    for (const row of await store.listByStatus(['stopping'], BATCH)) {
      if (row.stopping_at && nowMs - Date.parse(row.stopping_at) < STOPPING_RETRY_AFTER_MS) continue;
      await manager.cleanup(row);
      result.teardownRetried++;
    }
  });

  // 4. failed deploys whose cleanup never completed
  await step('failedCleanup', async () => {
    for (const row of await store.listFailedNeedingCleanup(BATCH)) {
      await manager.cleanup(row);
      result.failedCleaned++;
    }
  });

  // 5. Volumes past retention
  await step('volumes', async () => {
    for (const row of await store.listVolumesDue(manager.now().toISOString(), BATCH)) {
      try {
        for (const name of row.volume_names) await cli.volumeDelete(name);
        await store.patch(row.id, { volumes_deleted_at: manager.now().toISOString() });
        result.volumesDeleted++;
      } catch (err) {
        log.warn({ id: row.id, err: err instanceof Error ? err.message : String(err) }, 'volume delete failed, will retry');
      }
    }
  });

  // 6. orphans
  if (opts.scanOrphans) {
    await step('orphans', async () => {
      // Ask Modal for its apps FIRST, then read our rows. A deployment that finishes during the sweep is then either absent
      // from the app list or already has its row, so it can never look like an orphan. (Rows first would let an app that
      // appears and gets its row in between be stopped.) Every row that could own an app is considered: live ones and
      // rows still being cleaned up.
      const apps = await cli.appList();
      const owned = new Set<string>();
      const rows: DeploymentRow[] = await store.listByStatus(LIVE_STATUSES, 1000);
      for (const r of rows) owned.add(r.app_name);
      const pattern = managedAppPattern();
      for (const app of apps) {
        if (result.orphansStopped >= MAX_ORPHAN_STOPS_PER_RUN) break;
        if (!pattern.test(app.name) || !app.state.toLowerCase().startsWith('deployed') || owned.has(app.name)) continue;
        await cli.appStop(app.id || app.name);
        result.orphansStopped++;
        reportFailure('modal:orphan_stopped', new Error(`Stopped orphaned Modal app ${app.name}`), { app: app.name });
      }
    });
  }

  const total = Object.values(result).reduce((a, b) => a + b, 0);
  if (total > 0) log.info(result, 'reaper pass');
  return result;
}

// ----------------------------------------------------------------------------------------------
// Loop
// ----------------------------------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let passes = 0;

/** Starts the reaper. Orphan scans run every `orphanEvery` passes because they shell out to Modal. */
export function startDeploymentReaper(manager: DeploymentManager, intervalMs = 60_000, orphanEvery = 10): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      passes++;
      await runReaperOnce(manager, { scanOrphans: passes % orphanEvery === 0 });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'reaper pass crashed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  log.info({ intervalMs, orphanEvery }, 'deployment reaper started');
}

export function stopDeploymentReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  passes = 0;
}
