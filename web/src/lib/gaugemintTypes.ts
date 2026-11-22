// Types and tiny pure helpers shared by the server-side read client (gaugemintRead.ts) and the admin card (AdminGaugemint.tsx).
// Nothing here touches the environment or the network, so it is safe to import from client components.

/** Periods the admin card offers. The values are the `period` strings the Gaugemint stats API understands (7d, 30d, 12mo). */
export const GAUGEMINT_PERIODS = ['7d', '30d', '12mo'] as const
export type GaugemintPeriod = (typeof GAUGEMINT_PERIODS)[number]
export const DEFAULT_GAUGEMINT_PERIOD: GaugemintPeriod = '30d'

/** Anything that is not one of the three periods falls back to the default (the period is user input, never forwarded as is). */
export function parseGaugemintPeriod(v: string | null | undefined): GaugemintPeriod {
  return (GAUGEMINT_PERIODS as readonly string[]).includes(v ?? '') ? (v as GaugemintPeriod) : DEFAULT_GAUGEMINT_PERIOD
}

export interface GaugemintRow { name: string; visitors: number }
export interface GaugemintPageRow extends GaugemintRow { pageviews: number }
export interface GaugemintPoint { day: string; visitors: number; pageviews: number }

export interface GaugemintStats {
  site: string
  period: GaugemintPeriod
  /** `day` for 7d and 30d, `month` for 12mo (one bar per month, `day` holds YYYY-MM). */
  granularity: 'day' | 'month'
  totals: { visitors: number; pageviews: number; visits: number; bounce_rate: number; visit_duration: number }
  series: GaugemintPoint[]
  pages: GaugemintPageRow[]
  sources: GaugemintRow[]
  countries: GaugemintRow[]
  devices: GaugemintRow[]
}

/** Every failure is one of these kinds so the card can show a calm message. None of the messages contains the key. */
export type GaugemintErrorKind = 'not_configured' | 'unauthorized' | 'not_found' | 'rate_limited' | 'unreachable' | 'bad_response'
export interface GaugemintError { kind: GaugemintErrorKind; message: string; retryAfter?: number }

export type GaugemintResult =
  | { ok: true; stats: GaugemintStats; fetchedAt: string }
  | { ok: false; error: GaugemintError }

/** HTTP status the admin route answers for each error kind (same table as the Gaugemint admin-panel docs). */
export const GAUGEMINT_ERROR_STATUS: Record<GaugemintErrorKind, number> = {
  not_configured: 500,
  unauthorized: 502,
  not_found: 502,
  rate_limited: 503,
  unreachable: 504,
  bad_response: 502,
}

/** Visit duration in seconds as m:ss (or h:mm:ss from an hour up). */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null
const rows = (v: unknown) => Array.isArray(v) && v.every((r) => isObj(r) && typeof r.name === 'string' && typeof r.visitors === 'number')

/** Shape check for what /api/admin/gaugemint sends (the card renders nothing it has not checked). */
export function isGaugemintResult(v: unknown): v is GaugemintResult {
  if (!isObj(v)) return false
  if (v.ok === false) return isObj(v.error) && typeof v.error.kind === 'string' && typeof v.error.message === 'string'
  if (v.ok !== true || !isObj(v.stats)) return false
  const s = v.stats
  return isObj(s.totals) && ['visitors', 'pageviews', 'visits', 'bounce_rate', 'visit_duration'].every((k) => typeof s.totals[k] === 'number')
    && Array.isArray(s.series) && s.series.every((p: unknown) => isObj(p) && typeof p.day === 'string' && typeof p.visitors === 'number')
    && rows(s.pages) && rows(s.sources) && rows(s.countries) && rows(s.devices) && (s.granularity === 'day' || s.granularity === 'month')
}
