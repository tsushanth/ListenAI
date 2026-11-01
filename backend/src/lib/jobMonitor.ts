/**
 * End-to-end invariant + dead-man monitor for every async job table (jobs created vs jobs that reached a good end).
 * Catches what per-job failure signals cannot: a worker that is down, an engine with no capacity (jobs sit 'queued' or
 * 'processing' and nothing ever fails), a push queue that stopped delivering.
 *
 * Per table, each pass (every 30 min):
 *  - STALLED:       rows 20 min..2 h old still in a pending status (not for poll-driven tables)  -> <KIND>_JOBS_STALLED
 *  - NO_SUCCESS:    >= MIN_ATTEMPTS rows created 15 min..3 h ago and none reached the ok status -> <KIND>_JOBS_NO_SUCCESS
 *  - LOW_COMPLETION: >= MIN_DAILY created in 24 h and under 20% reached the ok status         -> <KIND>_JOBS_LOW_COMPLETION
 * Only counts go to the reporter. The message is the stable class, so one email per class per hour.
 */
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { reportFailure } from './failureReporter.js';
import { classError, type ReportFn } from './jobFailureSignal.js';

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

export async function runJobMonitor(deps: { db?: MonitorDb; now?: () => number; report?: ReportFn; sources?: JobSource[] } = {}): Promise<MonitorResult> {
  const db = deps.db ?? supabase;
  const now = (deps.now ?? Date.now)();
  const report = deps.report ?? reportFailure;
  const iso = (ms: number) => new Date(ms).toISOString();
  const result: MonitorResult = { alerts: [], errors: 0 };
  const raise = (cls: string, kind: string, ctx: Record<string, string>) => {
    result.alerts.push(cls);
    try { report('job_monitor', classError(cls), { kind, ...ctx }); } catch { /* never break the loop */ }
  };

  for (const s of deps.sources ?? JOB_SOURCES) {
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
  // A monitor that cannot read ANY table is itself blind: say so once.
  if (result.errors >= (deps.sources ?? JOB_SOURCES).length) raise('JOB_MONITOR_BLIND', 'all', { tables_failed: String(result.errors) });
  return result;
}
