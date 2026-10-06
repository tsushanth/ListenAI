// Shared policy for the self-serve per-user Modal deployments behind voiceConvert.ts and voiceIsolate.ts.
// Pure functions only (no I/O) so the decisions and the cleanup plan are unit-testable.
//
// Why this exists (S6 reliability report, finding 4 + ranked fix 2): POST /deploy used to run `modal deploy`
// (uncached build measured at 209 s against a 180 s timeout) for every user even when the backend already has a
// shared, always-available endpoint (VOICE_CONVERT_URL/SECRET), and returned 409 forever once any row existed,
// including a `failed` or stuck `deploying` one.

export interface ExistingDeployment {
  status: string;
  updated_at?: string | null;
}

export type DeployDecision =
  | { action: 'shared' }    // a shared endpoint serves this user: do not deploy anything
  | { action: 'conflict'; reason: 'in_progress' | 'active' } // 409
  | { action: 'retry' }     // previous attempt failed or is stale: clean it up and deploy again
  | { action: 'create' };   // first deployment

/** A `deploying` row older than this is treated as dead (modal deploy has a 180 s timeout; the backend may also have restarted mid-deploy). */
export const DEPLOYING_STALE_MS = 10 * 60 * 1000;

export function decideDeploy(opts: {
  existing: ExistingDeployment | null;
  sharedConfigured: boolean;
  /** Escape hatch: VOICE_PER_USER_DEPLOY=1 restores the legacy always-deploy behaviour even when a shared endpoint exists. */
  perUserDeployForced?: boolean;
  now?: number;
  staleMs?: number;
}): DeployDecision {
  const { existing, sharedConfigured, perUserDeployForced = false, now = Date.now(), staleMs = DEPLOYING_STALE_MS } = opts;
  if (existing && (existing.status === 'ready' || existing.status === 'stopping')) {
    return { action: 'conflict', reason: 'active' };
  }
  if (sharedConfigured && !perUserDeployForced) return { action: 'shared' };
  if (!existing) return { action: 'create' };
  if (existing.status === 'deploying') {
    const t = existing.updated_at ? Date.parse(existing.updated_at) : NaN;
    // Unknown age is treated as fresh: never start a second concurrent deploy on a guess.
    if (!Number.isFinite(t) || now - t < staleMs) return { action: 'conflict', reason: 'in_progress' };
  }
  // failed, stopped, or a stale deploying row
  return { action: 'retry' };
}

// --------------------------------------------------------------------------
// Cleanup planning for stale per-user resources (used by scripts/cleanup-stale-voice-deployments.ts)
// --------------------------------------------------------------------------

export type Feature = 'convert' | 'isolate';

export interface DeploymentRow {
  feature: Feature;
  user_id: string;
  app_name: string;
  status: string;
  job_count: number;
  updated_at: string;
}

export interface ModalInventory {
  /** App names, e.g. voice-convert-dev-user-ab12cd34-ef56 */
  apps: string[];
  /** Secret names, e.g. voice-convert-user-ab12cd34-ef56 */
  secrets: string[];
  /** Volume names, e.g. voice-convert-dev-jobs-user-ab12cd34-ef56 */
  volumes: string[];
}

export type CleanupAction =
  | { kind: 'modal_app_stop'; name: string; why: string }
  | { kind: 'modal_secret_delete'; name: string; why: string }
  | { kind: 'modal_volume_delete'; name: string; why: string }
  | { kind: 'db_row_delete'; feature: Feature; user_id: string; why: string };

const PER_USER = {
  convert: { app: 'voice-convert-dev-user-', secret: 'voice-convert-user-', volume: 'voice-convert-dev-jobs-user-' },
  isolate: { app: 'voice-isolate-dev-user-', secret: 'voice-isolate-user-', volume: 'voice-isolate-dev-jobs-user-' },
} as const;

/** The per-user suffix (`user-<8 hex>-<4 hex>`) for an app/secret/volume name of `feature`, or null if not a per-user resource. */
export function perUserSuffix(feature: Feature, kind: 'app' | 'secret' | 'volume', name: string): string | null {
  const prefix = PER_USER[feature][kind];
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}$/.test(rest) ? `user-${rest}` : null;
}

/**
 * Decides what to remove. Conservative by construction:
 *  - Only resources matching the exact per-user naming pattern are ever considered (the shared `voice-convert`,
 *    `voice-convert-dev-jobs`, etc. can never match).
 *  - A resource is kept when its suffix belongs to a LIVE row (status ready, or deploying and not stale).
 *  - `ready` rows are never deleted by age alone (a user may simply be idle); only failed/stopped/stale-deploying rows are.
 * Everything else with the per-user pattern is an orphan: the DB row is gone or dead.
 */
export function planCleanup(opts: {
  rows: DeploymentRow[];
  modal: ModalInventory;
  now?: number;
  minAgeMs?: number;
  staleMs?: number;
}): CleanupAction[] {
  const { rows, modal, now = Date.now(), minAgeMs = 24 * 3600 * 1000, staleMs = DEPLOYING_STALE_MS } = opts;
  const actions: CleanupAction[] = [];
  const live = new Set<string>(); // `${feature}:${suffix}` that must be kept
  const deadRows: DeploymentRow[] = [];

  for (const row of rows) {
    const suffix = perUserSuffix(row.feature, 'app', row.app_name);
    const t = Date.parse(row.updated_at);
    const age = Number.isFinite(t) ? now - t : 0;
    const isLive = row.status === 'ready' || (row.status === 'deploying' && age < staleMs);
    if (suffix && isLive) live.add(`${row.feature}:${suffix}`);
    else if (age >= minAgeMs) deadRows.push(row);
    else if (suffix) live.add(`${row.feature}:${suffix}`); // dead but recent: leave it, retry may reuse the slot
  }

  for (const feature of ['convert', 'isolate'] as const) {
    for (const [kind, names, mk] of [
      ['app', modal.apps, (name: string, why: string): CleanupAction => ({ kind: 'modal_app_stop', name, why })],
      ['secret', modal.secrets, (name: string, why: string): CleanupAction => ({ kind: 'modal_secret_delete', name, why })],
      ['volume', modal.volumes, (name: string, why: string): CleanupAction => ({ kind: 'modal_volume_delete', name, why })],
    ] as const) {
      for (const name of names) {
        const suffix = perUserSuffix(feature, kind, name);
        if (suffix && !live.has(`${feature}:${suffix}`)) actions.push(mk(name, 'per-user resource with no live deployment row'));
      }
    }
  }
  for (const row of deadRows) {
    actions.push({ kind: 'db_row_delete', feature: row.feature, user_id: row.user_id, why: `status=${row.status}, last update ${row.updated_at}` });
  }
  return actions;
}

/** Extracts names from `modal app|secret|volume list --json` output (apps use "Description", the others "Name"). Stopped apps are skipped. */
export function parseModalNames(json: string, kind: 'app' | 'secret' | 'volume'): string[] {
  const data: unknown = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('unexpected modal list output (not an array)');
  const out: string[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    const name = kind === 'app' ? item['Description'] : item['Name'];
    if (typeof name !== 'string' || !name) continue;
    if (kind === 'app' && item['State'] === 'stopped') continue;
    out.push(name);
  }
  return out;
}
