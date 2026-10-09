import { billableChars } from './realtimeTtsBilling.js';
import { supabase } from './supabaseClient.js';

export type Range = '24h' | '7d' | '30d';
export const RANGE_DAYS: Record<Range, number> = { '24h': 1, '7d': 7, '30d': 30 };
export function parseRange(v: unknown): Range {
  return v === '24h' || v === '7d' || v === '30d' ? v : '7d';
}
export function parseExcludeEmails(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export interface AdminUser { id: string; email: string | null; created_at: string }
export interface KeyRow { user_id: string; gateway_key_id: string; created_at: string; revoked_at: string | null }
export interface UsageRow { day: string; user_id: string; chars: number; piper_chars: number; audio_seconds: number; free_chars: number; updated_at: string }
export interface FreeCreditRow { user_id: string; granted: number; used: number }
export interface BillingRow { user_id: string; active: boolean; comped?: boolean | null }
export interface SttRow { user_id: string; status: string; created_at: string }
export interface HealthItem { name: string; status: 'up' | 'down' | 'slow' | 'asleep' | 'unknown'; latencyMs?: number; detail?: string; checkedAt: string }
export interface Totals { accounts: number; activeKeys: number; newAccounts: number; kokoroChars: number; piperChars: number; sttMinutes: number; freeCharsUsed: number; creditsGranted: number; creditsUsed: number; paidCustomers: number; billedUnits: number }
export interface FunnelStage { stage: string; count: number }
export type CustomerStatus = 'paid' | 'comped' | 'at limit' | 'free';
export interface Customer { userId: string; email: string | null; signedUp: string; activeKeys: number; firstRequest: string | null; lastRequest: string | null; chars7d: number; sttMinutes7d: number; creditsLeft: number; status: CustomerStatus }
export interface AttentionItem { level: 'warn' | 'info'; text: string }
export type Section<T> = { ok: true; data: T } | { ok: false; error: string };
export interface DashboardInputs { users: AdminUser[]; keys: KeyRow[]; usage: UsageRow[]; credits: FreeCreditRow[]; billing: BillingRow[]; stt: SttRow[]; health: HealthItem[]; now: Date; range: Range; excluded: Set<string> }

const DAY_MS = 86_400_000;
const utc = (d: Date) => d.toISOString().slice(0, 10);
const daysBack = (now: Date, n: number): string => utc(new Date(now.getTime() - (n - 1) * DAY_MS)); // first UTC day of an n-day window ending today

export function excludedUserIds(users: AdminUser[], excluded: Set<string>): Set<string> {
  return new Set(users.filter((u) => u.email && excluded.has(u.email.trim().toLowerCase())).map((u) => u.id));
}

function accountIds(i: DashboardInputs): Set<string> {
  const ex = excludedUserIds(i.users, i.excluded);
  return new Set(i.keys.map((k) => k.user_id).filter((id) => !ex.has(id)));
}
const inRange = (day: string, i: DashboardInputs) => day >= daysBack(i.now, RANGE_DAYS[i.range]);

export function buildTotals(i: DashboardInputs): Totals {
  const acc = accountIds(i);
  const keys = i.keys.filter((k) => acc.has(k.user_id));
  const firstKey = new Map<string, string>();
  for (const k of keys) { const cur = firstKey.get(k.user_id); if (!cur || k.created_at < cur) firstKey.set(k.user_id, k.created_at); }
  const since = new Date(`${daysBack(i.now, RANGE_DAYS[i.range])}T00:00:00Z`).toISOString();
  const rows = i.usage.filter((u) => acc.has(u.user_id) && inRange(u.day, i));
  const sum = (f: (u: UsageRow) => number) => rows.reduce((s, u) => s + f(u), 0);
  const credits = i.credits.filter((c) => acc.has(c.user_id));
  return {
    accounts: acc.size,
    activeKeys: keys.filter((k) => k.revoked_at === null).length,
    newAccounts: [...firstKey.values()].filter((c) => c >= since).length,
    kokoroChars: sum((u) => u.chars - u.piper_chars),
    piperChars: sum((u) => u.piper_chars),
    sttMinutes: sum((u) => u.audio_seconds) / 60,
    freeCharsUsed: sum((u) => u.free_chars),
    creditsGranted: credits.reduce((s, c) => s + c.granted, 0),
    creditsUsed: credits.reduce((s, c) => s + c.used, 0),
    paidCustomers: new Set(i.billing.filter((b) => b.active && !b.comped && acc.has(b.user_id)).map((b) => b.user_id)).size,
    billedUnits: sum((u) => billableChars({ chars: u.chars, piperChars: u.piper_chars, audioSeconds: u.audio_seconds })),
  };
}

const usedUp = (c: FreeCreditRow | undefined) => !!c && c.granted > 0 && c.used >= c.granted;

export function buildFunnel(i: DashboardInputs): FunnelStage[] {
  const acc = accountIds(i);
  const withUse = new Set(i.usage.filter((u) => acc.has(u.user_id) && (u.chars > 0 || u.audio_seconds > 0 || u.free_chars > 0)).map((u) => u.user_id));
  const credits = new Map(i.credits.map((c) => [c.user_id, c]));
  return [
    { stage: 'Created a key', count: acc.size },
    { stage: 'Made a first request', count: withUse.size },
    { stage: 'Used up free credits', count: [...acc].filter((id) => usedUp(credits.get(id))).length },
    { stage: 'Added a card', count: new Set(i.billing.filter((b) => b.active && !b.comped && acc.has(b.user_id)).map((b) => b.user_id)).size },
  ];
}

export function buildCustomers(i: DashboardInputs): Customer[] {
  const acc = accountIds(i);
  const emails = new Map(i.users.map((u) => [u.id, u]));
  const credits = new Map(i.credits.map((c) => [c.user_id, c]));
  const paid = new Set(i.billing.filter((b) => b.active && !b.comped).map((b) => b.user_id));
  const comped = new Set(i.billing.filter((b) => b.active && b.comped).map((b) => b.user_id));
  const since7 = daysBack(i.now, 7);
  return [...acc].map((id): Customer => {
    const rows = i.usage.filter((u) => u.user_id === id);
    const recent = rows.filter((u) => u.day >= since7);
    const c = credits.get(id);
    const days = rows.map((u) => u.day).sort();
    const last = rows.map((u) => u.updated_at).sort().pop() ?? null;
    return {
      userId: id,
      email: emails.get(id)?.email ?? null,
      signedUp: emails.get(id)?.created_at ?? '',
      activeKeys: i.keys.filter((k) => k.user_id === id && k.revoked_at === null).length,
      firstRequest: days[0] ?? null,
      lastRequest: last,
      chars7d: recent.reduce((s, u) => s + u.chars, 0),
      sttMinutes7d: recent.reduce((s, u) => s + u.audio_seconds, 0) / 60,
      creditsLeft: c ? Math.max(0, c.granted - c.used) : 0,
      status: comped.has(id) ? 'comped' : paid.has(id) ? 'paid' : usedUp(c) ? 'at limit' : 'free',
    };
  }).sort((a, b) => (b.lastRequest ?? '').localeCompare(a.lastRequest ?? ''));
}

export function buildAttention(i: DashboardInputs, customers: Customer[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const h of i.health) {
    if (h.status === 'down') out.push({ level: 'warn', text: `${h.name} is down` });
    if (h.status === 'slow') out.push({ level: 'warn', text: `${h.name} is slow (${h.latencyMs} ms)` });
  }
  for (const c of customers) if (c.status === 'at limit') out.push({ level: 'warn', text: `${c.email ?? c.userId} is out of free credits and has no card` });
  const today = utc(i.now), prior = new Set(Array.from({ length: 7 }, (_, n) => utc(new Date(i.now.getTime() - (n + 1) * DAY_MS))));
  for (const c of customers) {
    const rows = i.usage.filter((u) => u.user_id === c.userId);
    const todayChars = rows.filter((u) => u.day === today).reduce((s, u) => s + u.chars, 0);
    const priorAvg = rows.filter((u) => prior.has(u.day)).reduce((s, u) => s + u.chars, 0) / 7;
    if (todayChars >= 100_000 && todayChars >= 5 * priorAvg) out.push({ level: 'warn', text: `${c.email ?? c.userId}: usage spike` });
  }
  const hourAgo = new Date(i.now.getTime() - 3_600_000).toISOString();
  const ex = excludedUserIds(i.users, i.excluded);
  const failed = i.stt.filter((s) => s.status === 'failed' && s.created_at >= hourAgo && !ex.has(s.user_id)).length;
  if (failed >= 3) out.push({ level: 'warn', text: `Batch STT: ${failed} failed requests in the last hour` });
  return out;
}

export function buildSeries(i: DashboardInputs) {
  const acc = accountIds(i);
  const n = RANGE_DAYS[i.range];
  const firstKey = new Map<string, string>();
  for (const k of i.keys) if (acc.has(k.user_id)) { const cur = firstKey.get(k.user_id); if (!cur || k.created_at < cur) firstKey.set(k.user_id, k.created_at); }
  return Array.from({ length: n }, (_, idx) => {
    const day = utc(new Date(i.now.getTime() - (n - 1 - idx) * DAY_MS));
    const rows = i.usage.filter((u) => u.day === day && acc.has(u.user_id));
    return {
      day,
      newAccounts: [...firstKey.values()].filter((c) => c.slice(0, 10) === day).length,
      chars: rows.reduce((s, u) => s + u.chars, 0),
      sttMinutes: rows.reduce((s, u) => s + u.audio_seconds, 0) / 60,
    };
  });
}

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, size = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

export async function section<T>(fn: () => Promise<T> | T): Promise<Section<T>> {
  try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e instanceof Error ? e.message : String(e)) || 'failed' }; }
}

export interface DashboardDeps {
  now(): Date;
  listUsers(): Promise<AdminUser[]>;
  listKeys(): Promise<KeyRow[]>;
  listUsage(sinceDay: string): Promise<UsageRow[]>;
  listFreeCredits(): Promise<FreeCreditRow[]>;
  listBilling(): Promise<BillingRow[]>;
  listRecentStt(sinceIso: string): Promise<SttRow[]>;
  probes(usage: UsageRow[], stt: SttRow[]): Promise<HealthItem[]>;
}
export interface DashboardResponse {
  generatedAt: string; range: Range; usageSince: string | null;
  attention: Section<AttentionItem[]>; health: Section<HealthItem[]>; totals: Section<Totals>;
  funnel: Section<FunnelStage[]>; customers: Section<Customer[]>; series: Section<ReturnType<typeof buildSeries>>;
}

export async function buildDashboard(deps: DashboardDeps, opts: { range: Range; excludeEmails: Set<string> }): Promise<DashboardResponse> {
  const now = deps.now();
  const range = opts.range;
  const sinceDay = utc(new Date(now.getTime() - 30 * DAY_MS)); // one fetch covers 24h/7d/30d and the spike baseline
  const [users, keys, usage, credits, billing, stt] = await Promise.all([
    section(() => deps.listUsers()), section(() => deps.listKeys()), section(() => deps.listUsage(sinceDay)),
    section(() => deps.listFreeCredits()), section(() => deps.listBilling()), section(() => deps.listRecentStt(new Date(now.getTime() - 3_600_000).toISOString())),
  ]);
  const health = await section(() => deps.probes(usage.ok ? usage.data : [], stt.ok ? stt.data : []));
  const need = <T extends { ok: boolean }>(...s: T[]) => s.find((x) => !x.ok) as ({ ok: false; error: string } | undefined);
  const build = <T>(deps_: Array<Section<any>>, f: (i: DashboardInputs) => T): Section<T> => {
    const bad = need(...deps_);
    if (bad) return { ok: false, error: bad.error };
    const i: DashboardInputs = {
      users: (users as any).data, keys: (keys as any).data, usage: usage.ok ? usage.data : [], credits: credits.ok ? credits.data : [],
      billing: billing.ok ? billing.data : [], stt: stt.ok ? stt.data : [], health: health.ok ? health.data : [], now, range, excluded: opts.excludeEmails,
    };
    try { return { ok: true, data: f(i) }; } catch (e) { return { ok: false, error: (e as Error).message }; }
  };
  const customers = build([users, keys, usage, credits, billing], (i) => buildCustomers(i));
  return {
    generatedAt: now.toISOString(), range,
    usageSince: usage.ok ? ([...usage.data.map((u) => u.day)].sort()[0] ?? null) : null,
    health,
    totals: build([users, keys, usage, credits, billing], (i) => buildTotals(i)),
    funnel: build([users, keys, usage, credits, billing], (i) => buildFunnel(i)),
    customers,
    series: build([users, keys, usage], (i) => buildSeries(i)),
    attention: build([users, keys, usage, credits, billing], (i) => buildAttention(i, customers.ok ? customers.data : [])),
  };
}

export const defaultDashboardDeps: DashboardDeps = {
  now: () => new Date(),
  async listUsers() {
    const out: AdminUser[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      out.push(...data.users.map((u) => ({ id: u.id, email: u.email ?? null, created_at: u.created_at })));
      if (data.users.length < 1000) return out;
    }
  },
  listKeys: () => fetchAll<KeyRow>((f, t) => supabase.from('realtimetts_api_keys').select('user_id, gateway_key_id, created_at, revoked_at').order('created_at').range(f, t)),
  listUsage: (sinceDay) => fetchAll<UsageRow>((f, t) => supabase.from('realtimetts_usage_daily').select('day, user_id, chars, piper_chars, audio_seconds, free_chars, updated_at').gte('day', sinceDay).order('day').range(f, t)),
  listFreeCredits: () => fetchAll<FreeCreditRow>((f, t) => supabase.from('realtimetts_free_credits').select('user_id, granted, used').order('user_id').range(f, t)),
  listBilling: () => fetchAll<BillingRow>((f, t) => supabase.from('realtimetts_billing').select('user_id, active, comped').order('user_id').range(f, t)),
  listRecentStt: (sinceIso) => fetchAll<SttRow>((f, t) => supabase.from('stt_transcriptions').select('user_id, status, created_at').gte('created_at', sinceIso).order('created_at').range(f, t)),
  probes: async (usage, stt) => (await import('./adminHealth.js')).collectHealth({ usage, stt, now: new Date() }),
};
