// Cookie-free, script-free page-view counting for readaloudai.org. The middleware calls shouldTrack() for every request and, for a
// real person loading a page, sends one anonymous event to PostHog. No cookie, no browser script, no stored IP: the visitor id is a
// hash of IP + user agent + the UTC day, so the same person is only linkable within one day.

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|pingdom|curl\/|wget|python-requests|httpclient|go-http|headless|lighthouse|node-fetch|axios|vercel-screenshot|fly\.io|healthcheck/i

export interface PageviewReq {
  method: string
  pathname: string
  accept: string | null
  userAgent: string | null
  purpose?: string | null // Purpose / Sec-Purpose / next-router-prefetch style headers, joined
}

/** True only for a human-looking GET that loads an HTML page (not assets, API calls, prefetches, bots or health checks). */
export function shouldTrack(r: PageviewReq): boolean {
  if (r.method !== 'GET') return false
  if (!r.accept || !r.accept.includes('text/html')) return false
  if (/^\/(api|_next|favicon|robots|sitemap|\.well-known)/.test(r.pathname) || /\.[a-z0-9]{2,5}$/i.test(r.pathname)) return false
  if (r.purpose && /prefetch|prerender/i.test(r.purpose)) return false
  const ua = r.userAgent || ''
  if (ua.length < 10 || BOT_UA.test(ua)) return false
  return true
}

export interface PageviewEvent {
  distinctId: string
  url: string
  pathname: string
  referrer: string | null
  ua: string
}

/** Only the referring site's host is kept, never its path or query, and our own host is dropped. */
export function referrerHost(ref: string | null | undefined, ownHost: string): string | null {
  if (!ref) return null
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '')
    return h === ownHost.replace(/^www\./, '') ? null : h
  } catch { return null }
}

/** Visitor id: first 16 hex chars of sha256(ip | ua | UTC day | salt). Pass a crypto-like digest function (edge: crypto.subtle). */
export async function visitorId(ip: string, ua: string, day: string, digest: (s: string) => Promise<string>): Promise<string> {
  return (await digest(`${ip}|${ua}|${day}|ra-pv`)).slice(0, 16)
}

export function toPostHog(e: PageviewEvent, apiKey: string, ip: string | null) {
  return {
    api_key: apiKey,
    event: '$pageview',
    distinct_id: `ra-pv-${e.distinctId}`,
    properties: {
      $host: 'readaloudai.org',
      $current_url: e.url,
      $pathname: e.pathname,
      $referrer: e.referrer ?? '$direct',
      $raw_user_agent: e.ua,
      $ip: ip || undefined, // lets PostHog derive country and city; PostHog does not need us to store it
      site: 'readaloudai.org',
      source: 'server',
      $process_person_profile: false,
    },
  }
}
