export type Section<T> = { ok: true; data: T } | { ok: false; error: string }
export type HealthStatus = 'up' | 'down' | 'slow' | 'asleep' | 'unknown'
export interface HealthItem { name: string; status: HealthStatus; latencyMs?: number; detail?: string; checkedAt: string }
export interface Totals { accounts: number; activeKeys: number; newAccounts: number; kokoroChars: number; piperChars: number; sttMinutes: number; freeCharsUsed: number; creditsGranted: number; creditsUsed: number; paidCustomers: number; billedUnits: number }
export interface FunnelStage { stage: string; count: number }
export type CustomerStatus = 'paid' | 'comped' | 'at limit' | 'free'
export interface Customer { userId: string; email: string | null; signedUp: string; activeKeys: number; firstRequest: string | null; lastRequest: string | null; chars7d: number; sttMinutes7d: number; creditsLeft: number; status: CustomerStatus }
export interface AttentionItem { level: 'warn' | 'info'; text: string }
export interface SeriesRow { day: string; newAccounts: number; chars: number; sttMinutes: number }
export interface DashboardData {
  generatedAt: string; range: '24h' | '7d' | '30d'; usageSince: string | null
  attention: Section<AttentionItem[]>; health: Section<HealthItem[]>; totals: Section<Totals>
  funnel: Section<FunnelStage[]>; customers: Section<Customer[]>; series: Section<SeriesRow[]>
}

export const fmtNumber = (n: number): string => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')
export function fmtChars(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const rounded1k = Math.round(abs / 1_000)
  if (rounded1k >= 1_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 1_000) return `${sign}${rounded1k}k`
  return `${sign}${String(Math.round(abs))}`
}
export function fmtMinutes(min: number): string {
  if (!Number.isFinite(min)) return '—'
  const rounded = Math.round(min * 10) / 10
  if (rounded >= 120) return `${(min / 60).toFixed(1).replace(/\.0$/, '')} h`
  return `${rounded} min`
}
export function fmtAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 90) return `${Math.round(s)}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
export function statusTone(s: CustomerStatus | HealthStatus): 'good' | 'warn' | 'muted' {
  if (s === 'paid' || s === 'up') return 'good'
  if (s === 'at limit' || s === 'down' || s === 'slow') return 'warn'
  return 'muted'
}
export function funnelPercent(stages: FunnelStage[]): Array<FunnelStage & { pct: number }> {
  const first = stages[0]?.count ?? 0
  return stages.map((s) => ({ ...s, pct: first > 0 ? Math.round((s.count / first) * 100) : 0 }))
}
export function sortCustomers(rows: Customer[], key: keyof Customer, dir: 'asc' | 'desc'): Customer[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[key] as unknown, y = b[key] as unknown
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * sign
  })
}
