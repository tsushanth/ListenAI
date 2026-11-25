/**
 * End-to-end invariant + dead-man monitor for every async job table (jobs created vs jobs that reached a good end).
 * Catches what per-job failure signals cannot: a worker that is down, an engine with no capacity (jobs sit 'queued' or
 * 'processing' and nothing ever fails), a push queue that stopped delivering.
 *
 * Per table, each pass (every 30 min):
 *  - STALLED:       rows 20 min..2 h old still in a pending status (not for poll-driven tables)  -> <KIND>_JOBS_STALLED
 *  - NO_SUCCESS:    >= MIN_ATTEMPTS rows created 15 min..3 h ago and none reached the ok status -> <KIND>_JOBS_NO_SUCCESS
 *  - LOW_COMPLETION: >= MIN_DAILY created in 24 h and under 20% reached the ok status         -> <KIND>_JOBS_LOW_COMPLETION
 * Tables that do not fit those three rules have a count check (COUNT_CHECKS), and jobs held only in memory (dubbing)
 * are passed in by the caller. A pass that could read at least one table posts a heartbeat, so a monitor that stops
 * running is noticed too.
 * Only counts go to the reporter. The message is the stable class, so one email per class per hour.
 */
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { reportFailure } from './failureReporter.js';
import { classError, type ReportFn } from './jobFailureSignal.js';
import { postHeartbeat } from './heartbeat.js';

export interface JobSource {
  kind: string;
  table: string;
  okStatuses: string[];
  pendingStatuses: string[];
  /** Rows whose status only changes when the client polls (voice convert / isolate): a quiet client is not a stall; their own reaper covers them. */
  pollDriven?: boolean;
}

export const JOB_SOURCES: JobSource[] = [
  { kind: 'TTS', table: 'tts_jobs', okStatuses: ['ready', 'partial_ready'], pendingStatuses: ['queued', 'processing'] },
  { kind: 'MUSIC', table: 'music_jobs', okStatuses: ['ready'], pendingStatuses: ['queued', 'processing'] },
  { kind: 'SOUND_EFFECT', table: 'sound_effect_jobs', okStatuses: ['ready'], pendingStatuses: ['queued', 'processing'] },
  { kind: 'STT', table: 'stt_transcriptions', okStatuses: ['done'], pendingStatuses: ['processing'] },
  { kind: 'VOICE_CONVERT', table: 'voice_conversions', okStatuses: ['done'], pendingStatuses: ['queued', 'processing'], pollDriven: true },
  { kind: 'VOICE_ISOLATE', table: 'voice_isolations', okStatuses: ['done'], pendingStatuses: ['queued', 'processing'], pollDriven: true },
];

export const STALL_AFTER_MS = 20 * 60 * 1000;
export const STALL_WINDOW_MS = 2 * 60 * 60 * 1000;
export const GRACE_MS = 15 * 60 * 1000;
export const NO_SUCCESS_WINDOW_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_ATTEMPTS = 3;
export const MIN_DAILY = 10;
export const MIN_COMPLETION_RATIO = 0.2;

export const HEARTBEAT_JOB = 'jobmonitor';
export const DEPLOY_STUCK_MS = 15 * 60 * 1000;
export const DEPLOY_FAILED_WINDOW_MS = 2 * 60 * 60 * 1000;

export type Filter = ['in', string, string[]] | ['gte' | 'lt', string, string] | ['notNull', string];

export interface CountCheck {
  /** The stable alert class. */
  cls: string;
  table: string;
  /** Raise when at least this many rows match `rows` ... */
  min: number;
  rows(now: number): Filter[];
  /** ... and, when given, no row matches this. */
  unlessAny?(now: number): Filter[];
}

const at = (ms: number) => new Date(ms).toISOString();
const lastDay = (now: number): Filter[] => [['gte', 'created_at', at(now - DAY_MS)], ['lt', 'created_at', at(now - GRACE_MS)]];

/** These rows change only when the client polls, so "failed and nothing succeeded" is the honest signal, not "stalled". */
const failing = (cls: string, table: string, ok: string): CountCheck => ({
  cls, table, min: MIN_ATTEMPTS,
  rows: (now) => [['in', 'status', ['failed']], ...lastDay(now)],
  unlessAny: (now) => [['in', 'status', [ok]], ...lastDay(now)],
});

const deployments = (kind: string, table: string): CountCheck[] => [
  { cls: `${kind}_DEPLOY_STUCK`, table, min: 1, rows: (now) => [['in', 'status', ['deploying']], ['lt', 'updated_at', at(now - DEPLOY_STUCK_MS)]] },
  { cls: `${kind}_DEPLOY_FAILED`, table, min: 1, rows: (now) => [['in', 'status', ['failed']], ['gte', 'updated_at', at(now - DEPLOY_FAILED_WINDOW_MS)]] },
];

export const COUNT_CHECKS: CountCheck[] = [
  failing('VOICE_DESIGN_FAILING', 'voice_design_jobs', 'ready'),
  failing('AUDIOBOOK_FAILING', 'audiobooks', 'completed'),
  // Instant cloning: consent phrases were issued and not one recording was accepted.
  { cls: 'VOICE_CLONE_CONSENT_NO_SUCCESS', table: 'voice_consent_challenges', min: MIN_ATTEMPTS, rows: lastDay, unlessAny: (now) => [['notNull', 'consumed_at'], ...lastDay(now)] },
  ...deployments('VOICE_CONVERT', 'user_voice_convert_deployments'),
  ...deployments('VOICE_ISOLATE', 'user_voice_isolate_deployments'),
];

/** Jobs that live only in this process (lost on restart, kept about an hour). */
export interface MemoryJobSource { kind: string; list(): Array<{ status: 'processing' | 'ready' | 'failed'; createdAt: string }> }

async function countWhere(db: MonitorDb, table: string, filters: Filter[]): Promise<number | null> {
  let q: any = db.from(table).select('*', { count: 'exact', head: true });
  for (const f of filters) {
    if (f[0] === 'in') q = q.in(f[1], f[2]);
    else if (f[0] === 'notNull') q = q.not(f[1], 'is', null);
    else q = q[f[0]](f[1], f[2]);
  }
  const { count: n, error } = await q;
  if (error) return null;
  return n ?? 0;
}

/** Narrow slice of the supabase client: count(*) with eq/in/gte/lt filters. */
export type MonitorDb = Pick<typeof supabase, 'from'>;

type Window = { gte?: string; lt?: string; statuses?: string[] };

async function count(db: MonitorDb, table: string, w: Window): Promise<number | null> {
  let q: any = db.from(table).select('id', { count: 'exact', head: true });
  if (w.statuses) q = q.in('status', w.statuses);
  if (w.gte) q = q.gte('created_at', w.gte);
  if (w.lt) q = q.lt('created_at', w.lt);
  const { count: n, error } = await q;
  if (error) return null;
  return n ?? 0;
}

export interface MonitorResult { alerts: string[]; errors: number }

export interface MonitorDeps {
  db?: MonitorDb; now?: () => number; report?: ReportFn; sources?: JobSource[]; checks?: CountCheck[]; memory?: MemoryJobSource[];
  beat?: (job: string) => Promise<unknown>;
}

export async function runJobMonitor(deps: MonitorDeps = {}): Promise<MonitorResult> {
  const db = deps.db ?? supabase;
  const now = (deps.now ?? Date.now)();
  const report = deps.report ?? reportFailure;
  const iso = (ms: number) => new Date(ms).toISOString();
  const result: MonitorResult = { alerts: [], errors: 0 };
  const raise = (cls: string, kind: string, ctx: Record<string, string>) => {
    result.alerts.push(cls);
    try { report('job_monitor', classError(cls), { kind, ...ctx }); } catch { /* never break the loop */ }
  };

  const sources = deps.sources ?? JOB_SOURCES;
  // A caller that picks its own job sources gets only the count checks it picks too.
  const checks = deps.checks ?? (deps.sources ? [] : COUNT_CHECKS);

  for (const s of sources) {
    try {
      // Only rows 20 min..2 h old: older leftovers (a deploy killed the request) must not re-alert for a day.
      const stalled = s.pollDriven ? 0 : await count(db, s.table, { statuses: s.pendingStatuses, lt: iso(now - STALL_AFTER_MS), gte: iso(now - STALL_WINDOW_MS) });
      if (stalled === null) { result.errors++; continue; }
      if (stalled > 0) raise(`${s.kind}_JOBS_STALLED`, s.kind, { stalled: String(stalled), over_minutes: String(STALL_AFTER_MS / 60000) });

      const attempts = await count(db, s.table, { gte: iso(now - NO_SUCCESS_WINDOW_MS), lt: iso(now - GRACE_MS) });
      if (attempts !== null && attempts >= MIN_ATTEMPTS) {
        const ok = await count(db, s.table, { statuses: s.okStatuses, gte: iso(now - NO_SUCCESS_WINDOW_MS), lt: iso(now - GRACE_MS) });
        if (ok === 0) raise(`${s.kind}_JOBS_NO_SUCCESS`, s.kind, { attempts_3h: String(attempts), ok_3h: '0' });
      }

      const day = await count(db, s.table, { gte: iso(now - DAY_MS), lt: iso(now - GRACE_MS) });
      if (day !== null && day >= MIN_DAILY) {
        const okDay = await count(db, s.table, { statuses: s.okStatuses, gte: iso(now - DAY_MS), lt: iso(now - GRACE_MS) });
        if (okDay !== null && okDay / day < MIN_COMPLETION_RATIO) {
          raise(`${s.kind}_JOBS_LOW_COMPLETION`, s.kind, { created_24h: String(day), ok_24h: String(okDay) });
        }
      }
    } catch (err) {
      result.errors++;
      logger.warn({ err, table: s.table }, 'job monitor pass failed for table (non-critical)');
    }
  }
  for (const c of checks) {
    try {
      const matched = await countWhere(db, c.table, c.rows(now));
      if (matched === null) { result.errors++; continue; }
      if (matched < c.min) continue;
      if (c.unlessAny) {
        const ok = await countWhere(db, c.table, c.unlessAny(now));
        if (ok === null) { result.errors++; continue; }
        if (ok > 0) continue;
      }
      raise(c.cls, c.table, { rows: String(matched) });
    } catch (err) {
      result.errors++;
      logger.warn({ err, table: c.table }, 'job monitor count check failed (non-critical)');
    }
  }

  for (const m of deps.memory ?? []) {
    try {
      const jobs = m.list();
      const stalled = jobs.filter((j) => j.status === 'processing' && Date.parse(j.createdAt) < now - STALL_AFTER_MS).length;
      if (stalled > 0) raise(`${m.kind}_JOBS_STALLED`, m.kind, { stalled: String(stalled), over_minutes: String(STALL_AFTER_MS / 60000) });
      const failed = jobs.filter((j) => j.status === 'failed').length;
      if (failed >= MIN_ATTEMPTS && !jobs.some((j) => j.status === 'ready')) raise(`${m.kind}_JOBS_NO_SUCCESS`, m.kind, { failed: String(failed) });
    } catch (err) {
      logger.warn({ err, kind: m.kind }, 'job monitor memory check failed (non-critical)');
    }
  }

  // A monitor that cannot read ANY table is itself blind: say so once, and send no heartbeat.
  const tables = sources.length + checks.length;
  if (result.errors >= tables) raise('JOB_MONITOR_BLIND', 'all', { tables_failed: String(result.errors) });
  else await (deps.beat ?? postHeartbeat)(HEARTBEAT_JOB).catch(() => undefined);
  return result;
}
