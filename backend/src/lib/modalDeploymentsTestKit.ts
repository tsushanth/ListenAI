// Test helpers for the Modal deployment lifecycle: an in-memory DeploymentStore that enforces the same
// rules as the database (one live row per user+service, compare-and-set transitions), a fake ModalCli that
// records every call, and a controllable clock. Not imported by production code.
import type { ModalCli, ModalApp } from './modalCli.js';
import type {
  DeploymentRow,
  DeploymentService,
  DeploymentStatus,
  DeploymentStore,
  DeployLimits,
  NewDeployment,
  ClaimCaps,
  ClaimResult,
} from './modalDeployments.js';
import { DeploymentManager, LIVE_STATUSES } from './modalDeployments.js';

export class FakeClock {
  constructor(public ms = Date.parse('2026-10-01T00:00:00.000Z')) {}
  now = () => new Date(this.ms);
  advance(ms: number) {
    this.ms += ms;
  }
}

export class MemoryStore implements DeploymentStore {
  rows = new Map<string, DeploymentRow>();
  private seq = 0;
  constructor(private clock: FakeClock) {}

  private stamp() {
    return this.clock.now().toISOString();
  }

  /** Mirrors the database function claim_modal_deployment: one atomic check-and-insert. */
  async claim(n: NewDeployment, caps: ClaimCaps): Promise<ClaimResult> {
    const rows = [...this.rows.values()];
    if (rows.some((r) => r.user_id === n.user_id && r.service === n.service && LIVE_STATUSES.includes(r.status))) return { conflict: true };
    if (rows.filter((r) => r.user_id === n.user_id && LIVE_STATUSES.includes(r.status)).length >= caps.maxPerUser) return { denied: 'user_cap' };
    if (rows.filter((r) => LIVE_STATUSES.includes(r.status)).length >= caps.maxGlobal) return { denied: 'global_cap' };
    if (rows.filter((r) => r.user_id === n.user_id && r.created_at >= caps.dailySinceIso).length >= caps.maxDaily) return { denied: 'daily_cap' };
    const id = `dep-${++this.seq}`;
    const t = this.stamp();
    const row: DeploymentRow = {
      id, ...n, status: 'requested', error: null, attempts: 0, job_count: 0, gpu_seconds: 0,
      created_at: t, updated_at: t, deploy_started_at: null, ready_at: null, last_used_at: null, expires_at: null,
      stopping_at: null, stopped_at: null, stop_reason: null, volume_delete_at: null, volumes_deleted_at: null,
    };
    this.rows.set(id, row);
    return { row: { ...row } };
  }
  async getById(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  async getLive(userId: string, service: DeploymentService) {
    for (const r of this.rows.values()) {
      if (r.user_id === userId && r.service === service && LIVE_STATUSES.includes(r.status)) return { ...r };
    }
    return null;
  }
  async getLatest(userId: string, service: DeploymentService) {
    const mine = [...this.rows.values()].filter((r) => r.user_id === userId && r.service === service);
    mine.sort((a, b) => (a.created_at === b.created_at ? Number(b.id.slice(4)) - Number(a.id.slice(4)) : a.created_at < b.created_at ? 1 : -1));
    return mine[0] ? { ...mine[0] } : null;
  }
  /** Synchronous: put a ready deployment in place, as if the user had already deployed. For route tests. */
  seedReady(userId: string, service: DeploymentService, url: string, secret: string, appName?: string): DeploymentRow {
    const id = `dep-${++this.seq}`;
    const t = this.stamp();
    const row: DeploymentRow = {
      id, user_id: userId, service, app_name: appName ?? `seed-${id}`, modal_url: url, secret_name: `seed-secret-${id}`, modal_secret: secret,
      volume_names: [], status: 'ready', error: null, attempts: 0, job_count: 0, gpu_seconds: 0,
      created_at: t, updated_at: t, deploy_started_at: t, ready_at: t, last_used_at: t,
      expires_at: new Date(this.clock.ms + 4 * 3_600_000).toISOString(),
      stopping_at: null, stopped_at: null, stop_reason: null, volume_delete_at: null, volumes_deleted_at: null,
    };
    this.rows.set(id, row);
    return row;
  }
  /** Number of live rows, for assertions. */
  async countLiveForTest(): Promise<number> {
    return [...this.rows.values()].filter((r) => LIVE_STATUSES.includes(r.status)).length;
  }
  /** Synchronous read of the user's live deployment, for assertions. */
  liveFor(userId: string, service: DeploymentService): DeploymentRow | undefined {
    return [...this.rows.values()].find((r) => r.user_id === userId && r.service === service && LIVE_STATUSES.includes(r.status));
  }
  /** Remove the user's live deployment for a service (synchronous), for route tests that re-seed. */
  removeLive(userId: string, service: DeploymentService) {
    for (const [id, r] of this.rows) if (r.user_id === userId && r.service === service && LIVE_STATUSES.includes(r.status)) this.rows.delete(id);
  }
  clear() {
    this.rows.clear();
  }
  async listForUser(userId: string) {
    return [...this.rows.values()].filter((r) => r.user_id === userId).map((r) => ({ ...r }));
  }
  async transition(id: string, from: DeploymentStatus[], patch: Partial<DeploymentRow>) {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    Object.assign(r, patch, { updated_at: this.stamp() });
    return { ...r };
  }
  async patch(id: string, patch: Partial<DeploymentRow>) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, patch, { updated_at: this.stamp() });
  }
  async listByStatus(statuses: DeploymentStatus[], limit: number) {
    return [...this.rows.values()].filter((r) => statuses.includes(r.status)).slice(0, limit).map((r) => ({ ...r }));
  }
  async listFailedNeedingCleanup(limit: number) {
    return [...this.rows.values()].filter((r) => r.status === 'failed' && !r.stopped_at).slice(0, limit).map((r) => ({ ...r }));
  }
  async listVolumesDue(nowIso: string, limit: number) {
    return [...this.rows.values()]
      .filter((r) => !r.volumes_deleted_at && r.volume_delete_at && r.volume_delete_at <= nowIso)
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export interface CliCall {
  op: string;
  args: unknown[];
}

export class FakeCli implements ModalCli {
  calls: CliCall[] = [];
  apps: ModalApp[] = [];
  /** op name -> error to throw (every time, or the next N times if `failTimes` is set). */
  failOn = new Map<string, Error>();
  failTimes = new Map<string, number>();
  /** Called inside appList(), before it answers: lets a test change state in the middle of an orphan sweep. */
  onAppList: (() => Promise<void> | void) | null = null;
  /** Each deploy() takes this long, and the number running at once is tracked. */
  deployDelayMs = 0;
  maxConcurrentDeploys = 0;
  private activeDeploys = 0;
  /** When set, a gated deploy() throws this after being released: a deploy that FAILS late, after something else already ran. */
  failDeployAfterGate: Error | null = null;
  /** When set, deploy() waits for release() so a test can interleave a teardown mid-deploy. */
  gateDeploy = false;
  private gate: { promise: Promise<void>; release: () => void } | null = null;
  deployStarted: Promise<void> | null = null;
  private onDeployStart: (() => void) | null = null;

  private record(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
    const err = this.failOn.get(op);
    if (err) {
      const left = this.failTimes.get(op);
      if (left === undefined) throw err;
      if (left > 0) {
        this.failTimes.set(op, left - 1);
        throw err;
      }
    }
  }
  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
  armDeployGate() {
    this.gateDeploy = true;
    let release!: () => void;
    const promise = new Promise<void>((res) => (release = res));
    this.gate = { promise, release };
    this.deployStarted = new Promise<void>((res) => (this.onDeployStart = res));
  }
  releaseDeploy() {
    this.gate?.release();
  }

  async secretCreate(name: string, key: string, value: string) {
    this.record('secretCreate', name, key, value);
  }
  async secretDelete(name: string) {
    this.record('secretDelete', name);
  }
  async deploy(file: string, env: Record<string, string>, timeoutMs: number) {
    this.activeDeploys++;
    this.maxConcurrentDeploys = Math.max(this.maxConcurrentDeploys, this.activeDeploys);
    try {
      this.record('deploy', file, env, timeoutMs);
      if (this.deployDelayMs) await new Promise((r) => setTimeout(r, this.deployDelayMs));
      if (this.gateDeploy) {
        this.onDeployStart?.();
        await this.gate?.promise;
        if (this.failDeployAfterGate) throw this.failDeployAfterGate;
      }
    } finally {
      this.activeDeploys--;
    }
  }
  async appStop(appName: string) {
    this.record('appStop', appName);
  }
  async appList() {
    this.record('appList');
    const answer = [...this.apps];
    await this.onAppList?.();
    return answer;
  }
  async volumeDelete(name: string) {
    this.record('volumeDelete', name);
  }
}

export const TEST_LIMITS: DeployLimits = {
  disabled: false,
  idleTtlMs: 30 * 60_000,
  maxAgeMs: 4 * 3_600_000,
  deployTimeoutMs: 10 * 60_000,
  maxActivePerUser: 3,
  maxActiveGlobal: 20,
  maxDeploysPerUserPerDay: 10,
  volumeRetentionMs: 24 * 3_600_000,
  requirePaymentMethod: true,
  maxConcurrentDeploys: 3,
};

export interface Harness {
  manager: DeploymentManager;
  store: MemoryStore;
  cli: FakeCli;
  clock: FakeClock;
  paying: Set<string>;
}

export function makeHarness(opts: { limits?: Partial<DeployLimits>; cliConfigured?: boolean; strictUserIds?: boolean } = {}): Harness {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const cli = new FakeCli();
  const paying = new Set<string>(['user-a', 'user-b', 'user-c', 'user-d']);
  let n = 0;
  const manager = new DeploymentManager({
    store,
    cli,
    limits: { ...TEST_LIMITS, ...(opts.limits ?? {}) },
    workspace: 'test-ws',
    cliConfigured: opts.cliConfigured ?? true,
    hasPaymentMethod: async (u) => paying.has(u),
    // Production accepts only account ids (UUIDs). Most tests use readable ids like 'user-a', so the check is off unless asked for.
    validateUserId: opts.strictUserIds ? undefined : () => true,
    now: clock.now,
    // Deterministic: 2 bytes -> "abcd"-style, 32 bytes -> distinct per call so secrets are unique per deployment.
    randomHex: (bytes) => (bytes === 4 ? 'abcd1234' : String(++n).padStart(bytes * 2, '0')),
  });
  return { manager, store, cli, clock, paying };
}
