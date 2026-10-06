import { NextFetchEvent, NextRequest, NextResponse } from 'next/server'
import { referrerHost, shouldTrack, toPostHog, visitorId } from '@/lib/pageview'

// Counts page loads (not assets/API/bots/prefetches) for readaloudai.org without cookies or a browser script. See lib/pageview.ts.
// PostHog's public ingest key is the same one the calldesk.tech site already ships; POSTHOG_KEY overrides it.
const KEY = process.env.POSTHOG_KEY || 'phc_rusZvdY7jczUGJWzQh2dZneuHN3uEiueYTimkNvNQGLR'
const HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '')

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function middleware(req: NextRequest, event: NextFetchEvent) {
  try {
    const ua = req.headers.get('user-agent')
    const purpose = [req.headers.get('purpose'), req.headers.get('sec-purpose'), req.headers.get('next-router-prefetch'), req.headers.get('x-middleware-prefetch')].filter(Boolean).join(' ')
    if (shouldTrack({ method: req.method, pathname: req.nextUrl.pathname, accept: req.headers.get('accept'), userAgent: ua, purpose })) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('fly-client-ip') || null
      const day = new Date().toISOString().slice(0, 10)
      event.waitUntil((async () => {
        try {
          const id = await visitorId(ip || 'unknown', ua || '', day, sha256Hex)
          const url = `https://readaloudai.org${req.nextUrl.pathname}${req.nextUrl.search ? '?' + req.nextUrl.search.slice(1, 120) : ''}`
          await fetch(`${HOST}/capture/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toPostHog({ distinctId: id, url, pathname: req.nextUrl.pathname, referrer: referrerHost(req.headers.get('referer'), 'readaloudai.org'), ua: ua || '' }, KEY, ip)),
          })
        } catch { /* analytics must never affect the site */ }
      })())
    }
  } catch { /* never block a request on analytics */ }
  return NextResponse.next()
}

export const config = { matcher: ['/((?!_next/|api/|favicon|.*\\..*).*)'] }
