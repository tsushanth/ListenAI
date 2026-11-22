// Server-side READ client for Gaugemint, our own analytics (https://guagemint.com): the website numbers of readaloudai.org for the
// admin page. Import this ONLY from server code (the /api/admin/gaugemint route). The key comes from process.env and must never reach
// the browser; the admin card in the browser talks to our own admin-gated route, never to Gaugemint. (The sender, gaugemint.ts, is a
// different job and is unchanged.)
//
// Env (read on every call, so a changed secret needs no rebuild):
//   GAUGEMINT_READ_KEY   read-only API key (starts with pr_), a Fly secret. A full-access key (pa_) is refused.
//   GAUGEMINT_URL        analytics server, shared with the sender (default https://guagemint.com)
//   GAUGEMINT_DOMAIN     the site as registered there, shared with the sender (default readaloudai.org). Fixed on the server:
//                        the domain is never taken from a request.
//
// Reads: GET /api/v1/stats/aggregate, /timeseries and /breakdown (page, source, country, device), 6 calls per period, cached 60 s per
// period inside this process (the key is limited to 300 requests a minute on the Gaugemint side). Each call has a 5 s timeout.
// Errors are typed (GaugemintError), never thrown, never cached, never contain the key.
import { gaugemintConfig } from './gaugemint.ts'
import {
  DEFAULT_GAUGEMINT_PERIOD, GAUGEMINT_PERIODS,
  type GaugemintError, type GaugemintPageRow, type GaugemintPeriod, type GaugemintPoint, type GaugemintResult, type GaugemintRow, type GaugemintStats,
} from './gaugemintTypes.ts'

export const GAUGEMINT_CACHE_MS = 60_000
export const GAUGEMINT_TIMEOUT_MS = 5_000
const TOP = 8

class Fail extends Error {
  detail: GaugemintError
  constructor(detail: GaugemintError) { super(detail.message); this.detail = detail }
}

export interface ReadConfig { url: string; domain: string; key: string }

/** Reads and validates the config. Throws Fail('not_configured') when there is no usable read-only key. */
export function gaugemintReadConfig(env: Record<string, string | undefined> = process.env): ReadConfig {
  const { url, domain } = gaugemintConfig(env)
  const key = (env.GAUGEMINT_READ_KEY || '').trim()
  if (!key) throw new Fail({ kind: 'not_configured', message: 'Gaugemint is not configured (GAUGEMINT_READ_KEY is not set on the server).' })
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
    throw new Fail({ kind: 'not_configured', message: 'GAUGEMINT_URL must be an https address.' })
  }
  if (!key.startsWith('pr_')) {
    throw new Fail({ kind: 'not_configured', message: 'GAUGEMINT_READ_KEY is not a read-only key (read-only keys start with "pr_"). Refusing to use a full-access key here.' })
  }
  return { url, domain, key }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function topRows(body: any, prop: string, empty: string): Array<{ name: string; visitors: number; pageviews: number }> {
  const rows: any[] = Array.isArray(body?.results) ? body.results : []
  return rows
    .map((r) => ({ name: String(r?.[prop] || empty), visitors: num(r?.visitors), pageviews: num(r?.pageviews) }))
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, TOP)
}

/** 12 months of daily rows become one bar per month (YYYY-MM): a 366-bar chart is unreadable. Daily visitor codes rotate, so months sum the days. */
export function monthlySeries(days: GaugemintPoint[]): GaugemintPoint[] {
  const months = new Map<string, GaugemintPoint>()
  for (const d of days) {
    const m = d.day.slice(0, 7)
    const cur = months.get(m) ?? { day: m, visitors: 0, pageviews: 0 }
    cur.visitors += d.visitors
    cur.pageviews += d.pageviews
    months.set(m, cur)
  }
  return Array.from(months.values()).sort((a, b) => (a.day < b.day ? -1 : 1))
}

export interface ReaderDeps {
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
  cacheMs?: number
}

/** A reader with its own 60 s cache. The module-level getGaugemintStats below is the one instance the route uses. */
export function createGaugemintReader(deps: ReaderDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? GAUGEMINT_TIMEOUT_MS
  const cacheMs = deps.cacheMs ?? GAUGEMINT_CACHE_MS
  const cache = new Map<string, { at: number; result: GaugemintResult & { ok: true } }>()
  const inflight = new Map<string, Promise<GaugemintResult>>()

  async function get(cfg: ReadConfig, path: string, params: Record<string, string>): Promise<any> {
    let res: Response
    try {
      res = await fetchImpl(`${cfg.url}${path}?${new URLSearchParams(params)}`, {
        headers: { Authorization: `Bearer ${cfg.key}`, Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new Fail({ kind: 'unreachable', message: 'Could not reach Gaugemint (timeout or network error).' })
    }
    if (res.status === 401) throw new Fail({ kind: 'unauthorized', message: 'Gaugemint rejected the read key (revoked or mistyped).' })
    if (res.status === 403) throw new Fail({ kind: 'unauthorized', message: 'Gaugemint refused the read key for this request.' })
    if (res.status === 404) throw new Fail({ kind: 'not_found', message: 'Gaugemint does not know this site for this key (wrong domain, or the key is not allowed to read it).' })
    if (res.status === 429) {
      const retryAfter = Math.max(1, Number(res.headers.get('retry-after')) || 60)
      throw new Fail({ kind: 'rate_limited', message: `Gaugemint is rate-limiting this key. Try again in ${retryAfter} s.`, retryAfter })
    }
    if (!res.ok) throw new Fail({ kind: 'bad_response', message: `Gaugemint answered ${res.status}.` })
    try { return await res.json() } catch { throw new Fail({ kind: 'bad_response', message: 'Gaugemint sent something that is not JSON.' }) }
  }

  async function load(cfg: ReadConfig, period: GaugemintPeriod): Promise<GaugemintResult> {
    const q = { site_id: cfg.domain, period }
    try {
      const [agg, ts, pages, sources, countries, devices] = await Promise.all([
        get(cfg, '/api/v1/stats/aggregate', { ...q, metrics: 'visitors,pageviews,visits,bounce_rate,visit_duration' }),
        get(cfg, '/api/v1/stats/timeseries', { ...q, metrics: 'visitors,pageviews' }),
        get(cfg, '/api/v1/stats/breakdown', { ...q, property: 'event:page', metrics: 'visitors,pageviews' }),
        get(cfg, '/api/v1/stats/breakdown', { ...q, property: 'visit:source', metrics: 'visitors' }),
        get(cfg, '/api/v1/stats/breakdown', { ...q, property: 'visit:country', metrics: 'visitors' }),
        get(cfg, '/api/v1/stats/breakdown', { ...q, property: 'visit:device', metrics: 'visitors' }),
      ])
      const r = agg?.results
      if (!r || typeof r !== 'object' || !Array.isArray(ts?.results)) {
        throw new Fail({ kind: 'bad_response', message: 'Unexpected answer from Gaugemint.' })
      }
      const days: GaugemintPoint[] = ts.results.map((d: any) => ({ day: String(d?.date ?? ''), visitors: num(d?.visitors), pageviews: num(d?.pageviews) }))
      const monthly = period === '12mo'
      const strip = (rows: Array<{ name: string; visitors: number; pageviews: number }>): GaugemintRow[] => rows.map(({ name, visitors }) => ({ name, visitors }))
      const stats: GaugemintStats = {
        site: cfg.domain,
        period,
        granularity: monthly ? 'month' : 'day',
        totals: {
          visitors: num(r.visitors?.value), pageviews: num(r.pageviews?.value), visits: num(r.visits?.value),
          bounce_rate: num(r.bounce_rate?.value), visit_duration: num(r.visit_duration?.value),
        },
        series: monthly ? monthlySeries(days) : days,
        pages: topRows(pages, 'page', '(none)') as GaugemintPageRow[],
        sources: strip(topRows(sources, 'source', 'Direct / None')),
        countries: strip(topRows(countries, 'country', 'Unknown')),
        devices: strip(topRows(devices, 'device', 'Unknown')),
      }
      return { ok: true, stats, fetchedAt: new Date(now()).toISOString() }
    } catch (e) {
      if (e instanceof Fail) return { ok: false, error: e.detail }
      return { ok: false, error: { kind: 'bad_response', message: 'Unexpected error while reading stats.' } }
    }
  }

  /** Never throws. Only successful answers are cached (60 s per period); concurrent calls for one period share one upstream round. */
  return async function getGaugemintStats(period: GaugemintPeriod = DEFAULT_GAUGEMINT_PERIOD): Promise<GaugemintResult> {
    if (!GAUGEMINT_PERIODS.includes(period)) period = DEFAULT_GAUGEMINT_PERIOD
    let cfg: ReadConfig
    try {
      cfg = gaugemintReadConfig(deps.env ?? process.env)
    } catch (e) {
      return { ok: false, error: e instanceof Fail ? e.detail : { kind: 'not_configured', message: 'Gaugemint is not configured.' } }
    }
    const k = `${cfg.url}|${cfg.domain}|${period}`
    const hit = cache.get(k)
    if (hit && now() - hit.at < cacheMs) return hit.result
    const running = inflight.get(k)
    if (running) return running
    const p = load(cfg, period).then((result) => {
      if (result.ok) cache.set(k, { at: now(), result })
      return result
    }).finally(() => { inflight.delete(k) })
    inflight.set(k, p)
    return p
  }
}

/** The instance the admin route uses (process.env, global fetch, 60 s cache, 5 s timeout). */
export const getGaugemintStats = createGaugemintReader()
