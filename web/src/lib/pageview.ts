// Cookie-free, script-free page-view counting for readaloudai.org. The middleware calls shouldTrack() for every request and, for a
// real person loading a page, sends one event to our own analytics server (Gaugemint, see lib/gaugemint.ts). No cookie, no browser
// script, no stored IP: Gaugemint derives the country and a daily anonymous visitor code from the address and discards it.

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|pingdom|curl\/|wget|python-requests|httpclient|go-http|headless|lighthouse|node-fetch|axios|vercel-screenshot|fly\.io|healthcheck/i

/** True for crawlers, monitors, headless browsers and clients that send no real user-agent. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const u = ua || ''
  return u.length < 10 || BOT_UA.test(u)
}

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
  return !isBotUserAgent(r.userAgent)
}

/** Only the referring site's host is kept, never its path or query, and our own host is dropped. */
export function referrerHost(ref: string | null | undefined, ownHost: string): string | null {
  if (!ref) return null
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '')
    return h === ownHost.replace(/^www\./, '') ? null : h
  } catch { return null }
}
