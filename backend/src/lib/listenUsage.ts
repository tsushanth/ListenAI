// Daily totals of Android listening, the only server-side trace the app's reader leaves: every cloud listening session starts
// with POST /api/realtime-tts/authorize. Counted: sessions granted, distinct installs, requests refused (quota, rate limit,
// unknown voice) and failed (upstream or server error).
//
// Counters are collected in memory and ADDED to the database every few minutes (and on shutdown), so a restart or a second
// machine does not lose or overwrite the day. The reporter then gets the database totals (idempotent per app/day/metric).
// Stored per row: a day, a hashed install id from the quota (never the id itself or an address), and counts. Requests
// without an install id share one 'anon' row. Tester-bypass requests are not counted.
//
// Never throws: it sits next to the authorize route and must not disturb it.
import type { NextFunction, Request, Response } from 'express';
import { isTtsTestBypass } from './ttsTestBypass.js';

export type ListenOutcome = 'ok' | 'refused' | 'failed';
export interface ListenRow { day: string; bucket: string; ok: number; refused: number; failed: number }
export interface ListenTotals { ok: number; installs: number; no_install_id: number; refused: number; failed: number }
export interface ListenDeps {
  add(rows: ListenRow[]): Promise<void>;
  totals(day: string): Promise<ListenTotals>;
  post(day: string, items: Array<{ metric: string; value: number }>): Promise<void>;
  now(): Date;
}

/** Rows held between flushes; beyond this, new installs are counted together under 'overflow' (memory bound). */
const MAX_PENDING_ROWS = 20_000;
const ANON = 'anon';
const OTHER = '-';

export class ListenUsage {
  private pending = new Map<string, ListenRow>();

  constructor(private now: () => number = Date.now) {}

  /** `bucket` is the quota's hashed install bucket ('id:…') for a granted session, else null. */
  record(outcome: ListenOutcome, bucket: string | null): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = outcome !== 'ok' ? OTHER : bucket && bucket.startsWith('id:') ? bucket : ANON;
    this.merge({ day, bucket: key, ok: outcome === 'ok' ? 1 : 0, refused: outcome === 'refused' ? 1 : 0, failed: outcome === 'failed' ? 1 : 0 });
  }

  private merge(row: ListenRow): void {
    let bucket = row.bucket;
    if (!this.pending.has(`${row.day} ${bucket}`) && this.pending.size >= MAX_PENDING_ROWS) bucket = 'overflow';
    const key = `${row.day} ${bucket}`;
    const cur = this.pending.get(key);
    if (!cur) this.pending.set(key, { ...row, bucket });
    else { cur.ok += row.ok; cur.refused += row.refused; cur.failed += row.failed; }
  }

  size(): number {
    return this.pending.size;
  }

  /** Adds what is pending to the database; on failure it is kept for the next try. Resolves true when nothing is left. */
  async flush(deps: Pick<ListenDeps, 'add'>, log: (msg: string) => void = console.warn): Promise<boolean> {
    if (this.pending.size === 0) return true;
    const rows = [...this.pending.values()];
    this.pending = new Map();
    try {
      await deps.add(rows);
      return true;
    } catch (err) {
      for (const r of rows) this.merge(r);
      log(`[listenUsage] could not store counts: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}

export const listenUsage = new ListenUsage();

/** Which outcome a finished authorize response was. */
export function listenOutcome(status: number): ListenOutcome | null {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 503 || (status >= 400 && status < 500)) return 'refused';
  if (status >= 500) return 'failed';
  return null;
}

/** Mounted before the rate limiters, so their refusals are counted too. The route sets res.locals.listenBucket. */
export function countListening(usage: ListenUsage = listenUsage) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'POST' && req.path === '/authorize' && !isTtsTestBypass(req)) {
      res.on('finish', () => {
        const outcome = listenOutcome(res.statusCode);
        if (outcome) usage.record(outcome, typeof res.locals.listenBucket === 'string' ? res.locals.listenBucket : null);
      });
    }
    next();
  };
}

export function listenMetrics(t: ListenTotals): Array<{ metric: string; value: number }> {
  return [
    { metric: 'listen.authorize_ok', value: t.ok },
    { metric: 'listen.installs', value: t.installs },
    { metric: 'listen.authorize_no_install_id', value: t.no_install_id },
    { metric: 'listen.authorize_refused', value: t.refused },
    { metric: 'listen.authorize_failed', value: t.failed },
  ];
}

/**
 * Stores what is pending, then posts today's and yesterday's totals (yesterday gets its final value after midnight UTC).
 * A day with no traffic posts zeros, so silence is visible. Never throws. Returns the days posted.
 */
export async function pushListenTotals(deps: ListenDeps, usage: ListenUsage = listenUsage, log: (msg: string) => void = console.warn): Promise<string[]> {
  const posted: string[] = [];
  await usage.flush(deps, log);
  const now = deps.now().getTime();
  for (const day of [new Date(now - 86_400_000), new Date(now)].map((d) => d.toISOString().slice(0, 10))) {
    try {
      await deps.post(day, listenMetrics(await deps.totals(day)));
      posted.push(day);
    } catch (err) {
      log(`[listenUsage] could not post ${day}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return posted;
}

export const defaultListenDeps: ListenDeps = {
  now: () => new Date(),
  // supabaseClient and reporterUsage are imported on use: they need the full backend environment, which tests do not have.
  async add(rows) {
    const { supabase } = await import('./supabaseClient.js');
    const { error } = await supabase.rpc('listen_daily_add', { p_rows: rows });
    if (error) throw new Error(error.message);
  },
  async totals(day) {
    const { supabase } = await import('./supabaseClient.js');
    const { data, error } = await supabase.rpc('listen_daily_totals', { p_day: day });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) ?? {};
    return {
      ok: Number(row.ok ?? 0), installs: Number(row.installs ?? 0), no_install_id: Number(row.no_install_id ?? 0),
      refused: Number(row.refused ?? 0), failed: Number(row.failed ?? 0),
    };
  },
  async post(day, items) {
    const key = process.env.FAILURE_REPORTER_KEY;
    if (!key) return;
    const { usageUrlFrom } = await import('./reporterUsage.js');
    const res = await fetch(usageUrlFrom(process.env.FAILURE_REPORTER_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': key },
      body: JSON.stringify(items.map((i) => ({ ...i, day }))),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`reporter usage ${res.status}`);
  },
};
