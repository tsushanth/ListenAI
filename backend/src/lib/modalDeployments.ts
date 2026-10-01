// Self-serve Modal deployments: one lifecycle for every feature that runs on a per-user Modal app.
//
//   requested -> deploying -> ready -> stopping -> stopped        (failed from requested/deploying)
//
// The user deploys (POST /deploy), the backend creates a Modal app dedicated to that user, jobs for that
// user are routed to it, and it is torn down on request (DELETE /deploy), after an idle timeout, or at a
// maximum age. Every app runs in OUR Modal workspace, so the limits here are what protect our bill.
//
// Design notes:
//  - State changes are compare-and-set updates in the database (store.transition), so two backend machines
//    running the reaper at once, or a user racing the reaper, cannot double-process a deployment.
//  - Deploys run in-process but are recoverable: the reaper fails and cleans up any deployment that has been
//    requested/deploying for too long, so a backend restart cannot strand a row.
//  - The store and the Modal CLI are injected, so the whole lifecycle is unit-tested without Modal or Supabase.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { supabase } from './supabaseClient.js';
import { createModalCli, redact, type ModalCli } from './modalCli.js';
import { isBillingActiveForUser } from './realtimeTtsBilling.js';
import { reportFailure } from './failureReporter.js';

const log = logger.child({ module: 'modalDeployments' });

// ----------------------------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------------------------

export type DeploymentService = 'convert' | 'isolate' | 'sound_effect' | 'music' | 'dub';
export type DeploymentStatus = 'requested' | 'deploying' | 'ready' | 'stopping' | 'stopped' | 'failed';

export const LIVE_STATUSES: DeploymentStatus[] = ['requested', 'deploying', 'ready', 'stopping'];

export interface DeploymentRow {
  id: string;
  user_id: string;
  service: DeploymentService;
  app_name: string;
  modal_url: string;
  secret_name: string;
  modal_secret: string;
  status: DeploymentStatus;
  error: string | null;
  attempts: number;
  job_count: number;
  gpu_seconds: number;
  created_at: string;
  updated_at: string;
  deploy_started_at: string | null;
  ready_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  stopping_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  volume_names: string[];
  volume_delete_at: string | null;
  volumes_deleted_at: string | null;
}

export type NewDeployment = Pick<
  DeploymentRow,
  'user_id' | 'service' | 'app_name' | 'modal_url' | 'secret_name' | 'modal_secret' | 'volume_names'
>;

/** What the API returns. Never includes the per-deployment secret. */
export interface PublicDeployment {
  id: string;
  service: DeploymentService;
  status: DeploymentStatus;
  app_name: string;
  modal_url: string;
  error: string | null;
  job_count: number;
  created_at: string;
  ready_at: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  stop_reason: string | null;
  /** When the system will tear this down if nothing else happens (idle timeout or maximum age). */
  auto_teardown_at: string | null;
  seconds_until_auto_teardown: number | null;
}

export type DenyCode =
  | 'service_unavailable'
  | 'not_configured'
  | 'deployments_disabled'
  | 'payment_required'
  | 'user_cap'
  | 'global_cap'
  | 'daily_cap';

export type DeployOutcome =
  | { kind: 'accepted'; deployment: PublicDeployment }
  | { kind: 'exists'; deployment: PublicDeployment }
  | { kind: 'denied'; code: DenyCode; message: string };

export interface DeployTarget {
  deploymentId: string;
  url: string;
  secret: string;
  lastUsedAt: string | null;
  jobCount: number;
}

// ----------------------------------------------------------------------------------------------
// Service registry
// ----------------------------------------------------------------------------------------------

export interface ServiceSpec {
  service: DeploymentService;
  /** Human name used in messages ("voice conversion"). */
  label: string;
  /** False until the worker file is parameterised for per-user deploys. */
  available: boolean;
  unavailableReason?: string;
  /** Path of the Modal file, relative to the backend working directory. */
  modalFile: string;
  /** Modal app name = appPrefix + appSuffix. */
  appPrefix: string;
  /** Modal Secret name = secretPrefix + appSuffix. */
  secretPrefix: string;
  /** Key inside the Modal Secret that holds the bearer secret. */
  secretKey: string;
  /** Environment variables the Modal file reads to name its app and secret per user. */
  suffixEnv: string;
  secretNameEnv: string;
  /** Web endpoint label: https://<workspace>--<app>-<urlLabel>.modal.run */
  urlLabel: string;
  /** Per-user Volume name = volumePrefix + appSuffix. Deleted after the retention window. */
  volumePrefixes: string[];
}

export const SERVICE_SPECS: Record<DeploymentService, ServiceSpec> = {
  convert: {
    service: 'convert',
    label: 'voice conversion',
    available: true,
    modalFile: 'modal/convert_job.py',
    appPrefix: 'voice-convert-dev',
    secretPrefix: 'voice-convert',
    secretKey: 'CONVERT_SECRET',
    suffixEnv: 'VOICE_CONVERT_APP_SUFFIX',
    secretNameEnv: 'VOICE_CONVERT_SECRET_NAME',
    urlLabel: 'api',
    volumePrefixes: ['voice-convert-dev-jobs'],
  },
  isolate: {
    service: 'isolate',
    label: 'voice isolation',
    available: true,
    modalFile: 'modal/isolate_job.py',
    appPrefix: 'voice-isolate-dev',
    secretPrefix: 'voice-isolate',
    secretKey: 'ISOLATE_SECRET',
    suffixEnv: 'VOICE_ISOLATE_APP_SUFFIX',
    secretNameEnv: 'VOICE_ISOLATE_SECRET_NAME',
    urlLabel: 'api',
    volumePrefixes: ['voice-isolate-dev-jobs'],
  },
  sound_effect: {
    service: 'sound_effect',
    label: 'sound effects',
    available: true,
    modalFile: 'modal/sound_effects_worker.py',
    // Short on purpose: Modal's endpoint subdomain is "<workspace>--<app>-<function>" and is capped at 63 characters.
    appPrefix: 'sfx-readaloud',
    secretPrefix: 'sfx-readaloud',
    secretKey: 'SOUND_EFFECTS_WORKER_SHARED_SECRET',
    suffixEnv: 'SOUND_EFFECTS_APP_SUFFIX',
    secretNameEnv: 'SOUND_EFFECTS_SECRET_NAME',
    urlLabel: 'web', // the worker's web function is named `web`
    volumePrefixes: [], // generation is synchronous and returns audio bytes; checkpoints are a shared read-only Volume
  },
  music: {
    service: 'music',
    label: 'text-to-music',
    available: true,
    modalFile: 'modal/music_worker.py',
    appPrefix: 'music-readaloud',
    secretPrefix: 'music-readaloud',
    secretKey: 'MUSIC_WORKER_SHARED_SECRET',
    suffixEnv: 'MUSIC_APP_SUFFIX',
    secretNameEnv: 'MUSIC_SECRET_NAME',
    urlLabel: 'web', // the worker's web function is named `web`
    volumePrefixes: [], // generation is synchronous and returns audio bytes; checkpoints are a shared read-only Volume
  },
  dub: {
    service: 'dub',
    label: 'dubbing',
    available: true,
    // Dubbing chains speech-to-text, Claude translation and the platform's own TTS. Only the speech-to-text step is a
    // Modal resource, so the per-user app is the STT worker (vendored from realtime-tts/worker-stt-prod).
    modalFile: 'modal/dub_worker.py',
    appPrefix: 'dub-readaloud',
    secretPrefix: 'dub-readaloud',
    secretKey: 'MODAL_SESSION_SECRET', // the worker verifies HMAC session tokens signed with this (lib/dubSessionToken.ts)
    suffixEnv: 'DUB_APP_SUFFIX',
    secretNameEnv: 'DUB_SECRET_NAME',
    urlLabel: 'stt-web', // class STT's `web` method: Modal names class endpoints <app>-<class>-<method>
    volumePrefixes: [], // the model is baked into the image; requests are synchronous
  },
};

/** The job's owner has no ready deployment (never deployed, torn down, or idle/age expired). Thrown by workers and routes. */
export class DeploymentRequiredError extends Error {
  constructor(readonly service?: DeploymentService) {
    super(service ? `No active ${SERVICE_SPECS[service].label} deployment for this user.` : 'No active deployment for this user.');
    this.name = 'DeploymentRequiredError';
  }
}

export function isDeploymentService(v: unknown): v is DeploymentService {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(SERVICE_SPECS, v);
}

/** Matches an app this system created: <prefix>-user-<8 hex>-<4 hex>. Used to find orphans. */
export function managedAppPattern(): RegExp {
  const prefixes = Object.values(SERVICE_SPECS).map((s) => s.appPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(?:${prefixes.join('|')})-user-[0-9a-f]{8}-[0-9a-f]{4}$`);
}

// ----------------------------------------------------------------------------------------------
// Limits
// ----------------------------------------------------------------------------------------------

export interface DeployLimits {
  disabled: boolean;
  idleTtlMs: number;
  maxAgeMs: number;
  deployTimeoutMs: number;
  maxActivePerUser: number;
  maxActiveGlobal: number;
  maxDeploysPerUserPerDay: number;
  volumeRetentionMs: number;
  requirePaymentMethod: boolean;
}

const MIN = 60_000;
const HOUR = 3_600_000;

export function limitsFromConfig(c: typeof config = config): DeployLimits {
  return {
    disabled: c.MODAL_DEPLOYMENTS_DISABLED === 'true',
    idleTtlMs: c.MODAL_DEPLOY_IDLE_TTL_MIN * MIN,
    maxAgeMs: c.MODAL_DEPLOY_MAX_AGE_MIN * MIN,
    deployTimeoutMs: c.MODAL_DEPLOY_TIMEOUT_MIN * MIN,
    maxActivePerUser: c.MODAL_MAX_ACTIVE_PER_USER,
    maxActiveGlobal: c.MODAL_MAX_ACTIVE_GLOBAL,
    maxDeploysPerUserPerDay: c.MODAL_MAX_DEPLOYS_PER_USER_PER_DAY,
    volumeRetentionMs: c.MODAL_VOLUME_RETENTION_HOURS * HOUR,
    requirePaymentMethod: c.MODAL_DEPLOY_REQUIRE_PAYMENT_METHOD !== 'false',
  };
}

// ----------------------------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------------------------

export interface DeploymentStore {
  /** `conflict` is true when the one-live-deployment-per-user-per-service index rejected the insert. */
  insert(row: NewDeployment): Promise<{ row?: DeploymentRow; conflict?: boolean }>;
  getById(id: string): Promise<DeploymentRow | null>;
  getLive(userId: string, service: DeploymentService): Promise<DeploymentRow | null>;
  /** Most recent deployment for this user and service in any status, so a failed or stopped one is still visible. */
  getLatest(userId: string, service: DeploymentService): Promise<DeploymentRow | null>;
  listForUser(userId: string, limit?: number): Promise<DeploymentRow[]>;
  /** Compare-and-set: applies `patch` only if the row is currently in one of `from`. Returns the new row or null. */
  transition(id: string, from: DeploymentStatus[], patch: Partial<DeploymentRow>): Promise<DeploymentRow | null>;
  /** Unconditional update for bookkeeping fields (last_used_at, job_count, attempts, ...). */
  patch(id: string, patch: Partial<DeploymentRow>): Promise<void>;
  listByStatus(statuses: DeploymentStatus[], limit: number): Promise<DeploymentRow[]>;
  /** Rows whose cleanup (stopped_at) never completed: 'failed' rows needing cleanup. */
  listFailedNeedingCleanup(limit: number): Promise<DeploymentRow[]>;
  countLive(userId?: string): Promise<number>;
  countCreatedSince(userId: string, sinceIso: string): Promise<number>;
  listVolumesDue(nowIso: string, limit: number): Promise<DeploymentRow[]>;
}

export function createSupabaseStore(client = supabase): DeploymentStore {
  const T = 'modal_deployments';
  const unwrap = <R>(res: { data: R | null; error: { message: string; code?: string } | null }, what: string): R => {
    if (res.error) throw new Error(`modal_deployments ${what}: ${res.error.message}`);
    return res.data as R;
  };
  return {
    async insert(row) {
      const res = await client.from(T).insert(row).select().single();
      if (res.error) {
        if (res.error.code === '23505') return { conflict: true };
        throw new Error(`modal_deployments insert: ${res.error.message}`);
      }
      return { row: res.data as DeploymentRow };
    },
    async getById(id) {
      const res = await client.from(T).select('*').eq('id', id).maybeSingle();
      return unwrap(res, 'getById') as DeploymentRow | null;
    },
    async getLive(userId, service) {
      const res = await client.from(T).select('*').eq('user_id', userId).eq('service', service).in('status', LIVE_STATUSES).maybeSingle();
      return unwrap(res, 'getLive') as DeploymentRow | null;
    },
    async getLatest(userId, service) {
      const res = await client.from(T).select('*').eq('user_id', userId).eq('service', service).order('created_at', { ascending: false }).limit(1).maybeSingle();
      return unwrap(res, 'getLatest') as DeploymentRow | null;
    },
    async listForUser(userId, limit = 20) {
      const res = await client.from(T).select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(limit);
      return (unwrap(res, 'listForUser') ?? []) as DeploymentRow[];
    },
    async transition(id, from, patch) {
      const res = await client
        .from(T)
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', from)
        .select()
        .maybeSingle();
      return unwrap(res, 'transition') as DeploymentRow | null;
    },
    async patch(id, patch) {
      const res = await client.from(T).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
      if (res.error) throw new Error(`modal_deployments patch: ${res.error.message}`);
    },
    async listByStatus(statuses, limit) {
      const res = await client.from(T).select('*').in('status', statuses).order('created_at', { ascending: true }).limit(limit);
      return (unwrap(res, 'listByStatus') ?? []) as DeploymentRow[];
    },
    async listFailedNeedingCleanup(limit) {
      const res = await client.from(T).select('*').eq('status', 'failed').is('stopped_at', null).limit(limit);
      return (unwrap(res, 'listFailedNeedingCleanup') ?? []) as DeploymentRow[];
    },
    async countLive(userId) {
      let q = client.from(T).select('id', { count: 'exact', head: true }).in('status', LIVE_STATUSES);
      if (userId) q = q.eq('user_id', userId);
      const res = await q;
      if (res.error) throw new Error(`modal_deployments countLive: ${res.error.message}`);
      return res.count ?? 0;
    },
    async countCreatedSince(userId, sinceIso) {
      const res = await client.from(T).select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', sinceIso);
      if (res.error) throw new Error(`modal_deployments countCreatedSince: ${res.error.message}`);
      return res.count ?? 0;
    },
    async listVolumesDue(nowIso, limit) {
      const res = await client
        .from(T)
        .select('*')
        .is('volumes_deleted_at', null)
        .not('volume_delete_at', 'is', null)
        .lte('volume_delete_at', nowIso)
        .limit(limit);
      return (unwrap(res, 'listVolumesDue') ?? []) as DeploymentRow[];
    },
  };
}

// ----------------------------------------------------------------------------------------------
// Manager
// ----------------------------------------------------------------------------------------------

export const MAX_TEARDOWN_ATTEMPTS = 5;
const TOUCH_THROTTLE_MS = 60_000;

export interface DeploymentManagerDeps {
  store: DeploymentStore;
  cli: ModalCli;
  limits: DeployLimits;
  workspace: string;
  /** False when MODAL_TOKEN_ID/SECRET are missing: deploys are refused with `not_configured`. */
  cliConfigured: boolean;
  hasPaymentMethod: (userId: string) => Promise<boolean>;
  now?: () => Date;
  randomHex?: (bytes: number) => string;
}

const hex = (n: number) => randomBytes(n).toString('hex');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class DeploymentManager {
  readonly store: DeploymentStore;
  readonly cli: ModalCli;
  readonly limits: DeployLimits;
  private readonly workspace: string;
  private readonly cliConfigured: boolean;
  private readonly hasPaymentMethod: (userId: string) => Promise<boolean>;
  private readonly nowFn: () => Date;
  private readonly rand: (bytes: number) => string;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: DeploymentManagerDeps) {
    this.store = deps.store;
    this.cli = deps.cli;
    this.limits = deps.limits;
    this.workspace = deps.workspace;
    this.cliConfigured = deps.cliConfigured;
    this.hasPaymentMethod = deps.hasPaymentMethod;
    this.nowFn = deps.now ?? (() => new Date());
    this.rand = deps.randomHex ?? hex;
  }

  now(): Date {
    return this.nowFn();
  }

  private iso(ms = 0): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }

  /** Resolves when every deploy started by this instance has finished. For tests and graceful shutdown. */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  // -- public view ---------------------------------------------------------------------------

  toPublic(row: DeploymentRow): PublicDeployment {
    let autoAt: number | null = null;
    if (row.status === 'ready') {
      const idle = row.last_used_at ? Date.parse(row.last_used_at) + this.limits.idleTtlMs : Infinity;
      const max = row.expires_at ? Date.parse(row.expires_at) : Infinity;
      const t = Math.min(idle, max);
      autoAt = Number.isFinite(t) ? t : null;
    }
    return {
      id: row.id,
      service: row.service,
      status: row.status,
      app_name: row.app_name,
      modal_url: row.modal_url,
      error: row.error,
      job_count: row.job_count,
      created_at: row.created_at,
      ready_at: row.ready_at,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
      stop_reason: row.stop_reason,
      auto_teardown_at: autoAt === null ? null : new Date(autoAt).toISOString(),
      seconds_until_auto_teardown: autoAt === null ? null : Math.max(0, Math.round((autoAt - this.now().getTime()) / 1000)),
    };
  }

  /** The user's most recent deployment for this service in any status, or null if they never had one. */
  async getForUser(userId: string, service: DeploymentService): Promise<PublicDeployment | null> {
    const row = await this.store.getLatest(userId, service);
    return row ? this.toPublic(row) : null;
  }

  async listForUser(userId: string): Promise<PublicDeployment[]> {
    return (await this.store.listForUser(userId)).map((r) => this.toPublic(r));
  }

  // -- deploy --------------------------------------------------------------------------------

  async deploy(userId: string, service: DeploymentService): Promise<DeployOutcome> {
    const spec = SERVICE_SPECS[service];
    if (!spec.available) {
      return { kind: 'denied', code: 'service_unavailable', message: `Per-user ${spec.label} deployments are not available yet.` };
    }
    if (this.limits.disabled) {
      return { kind: 'denied', code: 'deployments_disabled', message: 'Deployments are temporarily disabled. Try again later.' };
    }
    if (!this.cliConfigured) {
      return { kind: 'denied', code: 'not_configured', message: `${capitalise(spec.label)} deployment is not configured on this backend.` };
    }

    const existing = await this.store.getLive(userId, service);
    if (existing) return { kind: 'exists', deployment: this.toPublic(existing) };

    if (this.limits.requirePaymentMethod && !(await this.hasPaymentMethod(userId))) {
      return {
        kind: 'denied',
        code: 'payment_required',
        message: 'Add a payment method to deploy. Deployments run GPU resources that are billed to your account.',
      };
    }
    if ((await this.store.countLive(userId)) >= this.limits.maxActivePerUser) {
      return { kind: 'denied', code: 'user_cap', message: `You can have at most ${this.limits.maxActivePerUser} active deployments. Tear one down first.` };
    }
    if ((await this.store.countLive()) >= this.limits.maxActiveGlobal) {
      return { kind: 'denied', code: 'global_cap', message: 'Deployment capacity is full right now. Try again in a few minutes.' };
    }
    const dayAgo = this.iso(-24 * HOUR);
    if ((await this.store.countCreatedSince(userId, dayAgo)) >= this.limits.maxDeploysPerUserPerDay) {
      return { kind: 'denied', code: 'daily_cap', message: `Daily deployment limit reached (${this.limits.maxDeploysPerUserPerDay} per 24 hours).` };
    }

    const suffix = `-user-${userId.replace(/-/g, '').slice(0, 8)}-${this.rand(2)}`;
    const appName = `${spec.appPrefix}${suffix}`;
    const inserted = await this.store.insert({
      user_id: userId,
      service,
      app_name: appName,
      modal_url: `https://${this.workspace}--${appName}-${spec.urlLabel}.modal.run`,
      secret_name: `${spec.secretPrefix}${suffix}`,
      modal_secret: this.rand(32),
      volume_names: spec.volumePrefixes.map((p) => `${p}${suffix}`),
    });
    if (inserted.conflict || !inserted.row) {
      const live = await this.store.getLive(userId, service);
      if (live) return { kind: 'exists', deployment: this.toPublic(live) };
      throw new Error('modal_deployments insert conflicted but no live row was found');
    }

    const row = inserted.row;
    const job = this.runDeploy(row, suffix).catch((err) => log.error({ err: errMsg(err), id: row.id }, 'unexpected deploy failure'));
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
    return { kind: 'accepted', deployment: this.toPublic(row) };
  }

  private async runDeploy(row: DeploymentRow, suffix: string): Promise<void> {
    const spec = SERVICE_SPECS[row.service];
    const started = await this.store.transition(row.id, ['requested'], { status: 'deploying', deploy_started_at: this.iso() });
    if (!started) return; // torn down before it began

    try {
      await this.cli.secretCreate(row.secret_name, spec.secretKey, row.modal_secret);
      await this.cli.deploy(
        spec.modalFile,
        { [spec.suffixEnv]: suffix, [spec.secretNameEnv]: row.secret_name },
        Math.max(60_000, this.limits.deployTimeoutMs - MIN),
      );
    } catch (err) {
      const message = redact(errMsg(err), [row.modal_secret]).slice(0, 500);
      log.error({ id: row.id, service: row.service, err: message }, 'modal deployment failed');
      reportFailure(`modal:deploy:${row.service}`, new Error(message), { deployment: row.id });
      const failed = await this.store.transition(row.id, ['requested', 'deploying'], { status: 'failed', error: message, stop_reason: 'deploy_failed' });
      if (failed) await this.cleanup(failed);
      return;
    }

    const now = this.now();
    const ready = await this.store.transition(row.id, ['deploying'], {
      status: 'ready',
      error: null,
      ready_at: now.toISOString(),
      last_used_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.limits.maxAgeMs).toISOString(),
    });
    if (!ready) {
      // Torn down or failed by the reaper while the CLI was still running. The app now exists with no live row.
      const latest = await this.store.getById(row.id);
      if (latest) await this.cleanup(latest);
    }
  }

  // -- use -----------------------------------------------------------------------------------

  /** Where to send this user's jobs, or null if they have no usable deployment (none, not ready, idle- or age-expired). */
  async resolveTarget(userId: string, service: DeploymentService): Promise<DeployTarget | null> {
    const row = await this.store.getLive(userId, service);
    if (!row || row.status !== 'ready') return null;
    const now = this.now().getTime();
    if (row.expires_at && Date.parse(row.expires_at) <= now) return null;
    if (row.last_used_at && Date.parse(row.last_used_at) + this.limits.idleTtlMs <= now) return null;
    return { deploymentId: row.id, url: row.modal_url, secret: row.modal_secret, lastUsedAt: row.last_used_at, jobCount: row.job_count };
  }

  /**
   * Record activity so the idle clock restarts. `job: true` also counts a newly submitted job. Plain activity
   * (polling a job, fetching a result) only writes if the last write was over a minute ago, so a client that
   * polls every few seconds does not turn into a database write per poll.
   */
  async touch(target: DeployTarget, opts: { job?: boolean } = {}): Promise<void> {
    if (opts.job) {
      await this.store.patch(target.deploymentId, { last_used_at: this.iso(), job_count: target.jobCount + 1 });
      return;
    }
    if (target.lastUsedAt && this.now().getTime() - Date.parse(target.lastUsedAt) < TOUCH_THROTTLE_MS) return;
    await this.store.patch(target.deploymentId, { last_used_at: this.iso() });
  }

  // -- teardown ------------------------------------------------------------------------------

  /** Tear down the user's live deployment for a service, if any. */
  async teardownForUser(userId: string, service: DeploymentService, reason = 'user'): Promise<'stopped' | 'stopping' | 'none'> {
    const live = await this.store.getLive(userId, service);
    if (!live) return 'none';
    const out = await this.teardown(live.id, reason);
    return out === 'noop' ? 'stopping' : out;
  }

  /** Idempotent. Returns what happened so the caller can report it. */
  async teardown(id: string, reason: string): Promise<'stopped' | 'stopping' | 'noop'> {
    const row = await this.store.getById(id);
    if (!row) return 'noop';
    if (row.status === 'stopped') return 'noop';
    if (row.status === 'failed') {
      if (row.stopped_at) return 'noop';
      return (await this.cleanup(row)) ? 'stopped' : 'stopping';
    }
    let target = row;
    if (row.status !== 'stopping') {
      const moved = await this.store.transition(id, ['requested', 'deploying', 'ready'], {
        status: 'stopping',
        stopping_at: this.iso(),
        stop_reason: reason,
      });
      if (!moved) return 'noop'; // someone else is already tearing it down
      target = moved;
    }
    return (await this.cleanup(target)) ? 'stopped' : 'stopping';
  }

  /** Stops the app and removes its Secret. Returns true when everything is gone (Volumes follow after retention). */
  async cleanup(row: DeploymentRow): Promise<boolean> {
    try {
      await this.cli.appStop(row.app_name);
      await this.cli.secretDelete(row.secret_name);
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = redact(errMsg(err), [row.modal_secret]).slice(0, 500);
      if (attempts >= MAX_TEARDOWN_ATTEMPTS) {
        // Give up retrying but say so loudly: this app may still be running on our bill.
        reportFailure('modal:teardown_stuck', new Error(message), { deployment: row.id, app: row.app_name });
        await this.store.patch(row.id, { attempts, error: message, stopped_at: this.iso() });
        return true;
      }
      await this.store.patch(row.id, { attempts, error: message });
      return false;
    }
    const patch: Partial<DeploymentRow> = {
      stopped_at: this.iso(),
      volume_delete_at: row.volume_names.length ? this.iso(this.limits.volumeRetentionMs) : null,
    };
    if (row.status === 'failed') {
      await this.store.patch(row.id, patch);
    } else {
      await this.store.transition(row.id, ['stopping'], { ...patch, status: 'stopped' });
    }
    return true;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ----------------------------------------------------------------------------------------------
// Process-wide instance
// ----------------------------------------------------------------------------------------------

let instance: DeploymentManager | null = null;

export function getDeploymentManager(): DeploymentManager {
  if (!instance) {
    const cliConfigured = !!(config.MODAL_TOKEN_ID && config.MODAL_TOKEN_SECRET);
    instance = new DeploymentManager({
      store: createSupabaseStore(),
      cli: createModalCli({ tokenId: config.MODAL_TOKEN_ID, tokenSecret: config.MODAL_TOKEN_SECRET, cwd: process.cwd() }),
      limits: limitsFromConfig(),
      workspace: config.MODAL_WORKSPACE || 't-sushanth',
      cliConfigured,
      hasPaymentMethod: isBillingActiveForUser,
    });
  }
  return instance;
}

/** Tests inject a manager built on a fake store and CLI; pass null to reset. */
export function setDeploymentManagerForTests(m: DeploymentManager | null): void {
  instance = m;
}
