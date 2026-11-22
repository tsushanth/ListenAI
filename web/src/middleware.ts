import { NextFetchEvent, NextRequest, NextResponse } from 'next/server'
import { clientIp, gaugemintConfig, optedOut, sendGaugemint } from '@/lib/gaugemint'
import { referrerHost, shouldTrack } from '@/lib/pageview'

// Counts page loads (not assets/API/bots/prefetches) for readaloudai.org without cookies or a browser script, and sends each one
// server-side to our own analytics (Gaugemint). Visitors who send Do Not Track or Global Privacy Control are not counted, and
// ANALYTICS_DISABLED=1 turns it off. See lib/pageview.ts and lib/gaugemint.ts.
export function middleware(req: NextRequest, event: NextFetchEvent) {
  try {
    const cfg = gaugemintConfig()
    const ua = req.headers.get('user-agent')
    const purpose = [req.headers.get('purpose'), req.headers.get('sec-purpose'), req.headers.get('next-router-prefetch'), req.headers.get('x-middleware-prefetch')].filter(Boolean).join(' ')
    if (!cfg.disabled && !optedOut(req.headers) && shouldTrack({ method: req.method, pathname: req.nextUrl.pathname, accept: req.headers.get('accept'), userAgent: ua, purpose })) {
      // req.nextUrl.pathname carries no query string; the search part is deliberately never sent.
      event.waitUntil(sendGaugemint({
        name: 'pageview',
        pathname: req.nextUrl.pathname,
        referrerHost: referrerHost(req.headers.get('referer'), cfg.domain),
        ip: clientIp(req.headers),
        userAgent: ua,
      }, cfg))
    }
  } catch { /* never block a request on analytics */ }
  return NextResponse.next()
}

export const config = { matcher: ['/((?!_next/|api/|favicon|.*\\..*).*)'] }
