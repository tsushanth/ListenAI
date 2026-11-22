// Server-side sender for Gaugemint, our own analytics (https://guagemint.com). Nothing runs in the browser and no cookie is set:
// the middleware (page loads) and the demo-event route (homepage demo events) call sendGaugemint() from the server. Gaugemint turns
// the visitor's address into a country and a daily anonymous code and does not store the address, so the address and the browser's
// user-agent are forwarded in X-Forwarded-For / User-Agent. The query string of a page is never sent.
//
// Env (read on every call, so it can change without a rebuild):
//   GAUGEMINT_URL        base URL of the analytics server (default https://guagemint.com)
//   GAUGEMINT_DOMAIN     site id registered there (default readaloudai.org)
//   ANALYTICS_DISABLED=1 kill switch: nothing is sent

export const DEFAULT_GAUGEMINT_URL = 'https://guagemint.com'
export const DEFAULT_GAUGEMINT_DOMAIN = 'readaloudai.org'

export interface GaugemintConfig {
  url: string
  domain: string
  disabled: boolean
}

export function gaugemintConfig(env: Record<string, string | undefined> = process.env): GaugemintConfig {
  const url = (env.GAUGEMINT_URL || DEFAULT_GAUGEMINT_URL).trim().replace(/\/+$/, '')
  const domain = (env.GAUGEMINT_DOMAIN || DEFAULT_GAUGEMINT_DOMAIN).trim()
  const off = (env.ANALYTICS_DISABLED || '').trim().toLowerCase()
  return { url, domain, disabled: off === '1' || off === 'true' }
}

/** True when the visitor asked not to be counted: Do Not Track (`DNT: 1`) or Global Privacy Control (`Sec-GPC: 1`). */
export function optedOut(h: { get(name: string): string | null }): boolean {
  return h.get('dnt')?.trim() === '1' || h.get('sec-gpc')?.trim() === '1'
}

/** The visitor's address: Fly's own client-address header first (set by the proxy, not by the visitor), then the first X-Forwarded-For entry. */
export function clientIp(h: { get(name: string): string | null }): string | null {
  return h.get('fly-client-ip')?.trim() || h.get('x-forwarded-for')?.split(',')[0].trim() || null
}

export interface GaugemintEvent {
  /** `pageview` or a custom event name. */
  name: string
  /** Path only; any query string or fragment is dropped here. */
  pathname: string
  /** Referring site's host (see referrerHost), or null. */
  referrerHost?: string | null
  /** Flat scalar properties for custom events. Nulls and undefined are left out. */
  props?: Record<string, string | number | boolean | null | undefined>
  ip: string | null
  userAgent: string | null
}

const SEND_TIMEOUT_MS = 3000

/**
 * Sends one event. Never throws and never rejects: returns true only when Gaugemint accepted it. Sends nothing when the kill switch
 * is on or there is no user-agent to forward (without it every visitor would collapse into one).
 */
export async function sendGaugemint(
  ev: GaugemintEvent,
  cfg: GaugemintConfig = gaugemintConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    if (cfg.disabled) return false
    const path = ('/' + (ev.pathname || '').replace(/^\/+/, '')).split(/[?#]/)[0]
    const body: Record<string, unknown> = {
      domain: cfg.domain,
      name: ev.name,
      url: `https://${cfg.domain}${path}`,
    }
    if (ev.referrerHost) body.referrer = `https://${ev.referrerHost}/`
    if (ev.props) {
      const props: Record<string, string | number | boolean> = {}
      for (const [k, v] of Object.entries(ev.props)) if (v !== null && v !== undefined) props[k] = v
      if (Object.keys(props).length) body.props = props
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ev.ip) headers['X-Forwarded-For'] = ev.ip
    if (ev.userAgent) headers['User-Agent'] = ev.userAgent
    const res = await fetchImpl(`${cfg.url}/api/event`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    return res.status >= 200 && res.status < 300
  } catch {
    return false // analytics must never affect the site
  }
}
