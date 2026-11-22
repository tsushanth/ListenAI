import { NextRequest, NextResponse } from 'next/server'
import { parseDemoEvent } from '@/lib/demoEvent'
import { clientIp, gaugemintConfig, optedOut, sendGaugemint } from '@/lib/gaugemint'
import { isBotUserAgent } from '@/lib/pageview'

// Receives anonymous events from the homepage voice demo (what was played, time to first audio, errors) and forwards them to our own
// analytics (Gaugemint) as custom events named demo_<kind>. The typed text is never sent. Visitors who send Do Not Track or Global
// Privacy Control, and ANALYTICS_DISABLED=1, send nothing.
const hits = new Map<string, number[]>()
const LIMIT = 60
const WINDOW_MS = 60_000

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= LIMIT) return new NextResponse(null, { status: 429 })
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) hits.clear()

  const ev = parseDemoEvent(await req.json().catch(() => null))
  if (!ev) return new NextResponse(null, { status: 400 })

  console.log('[demo-event]', JSON.stringify(ev))
  const ua = req.headers.get('user-agent')
  const cfg = gaugemintConfig()
  if (!cfg.disabled && !optedOut(req.headers) && !isBotUserAgent(ua)) {
    // Not awaited: the demo never waits on analytics. sendGaugemint never throws.
    void sendGaugemint({
      name: `demo_${ev.kind}`,
      pathname: '/',
      props: {
        preset: ev.preset,
        custom_text: ev.preset < 0,
        chars: ev.chars,
        first_audio_ms: ev.firstMs,
        audio_ms: ev.audioMs,
        reason: ev.reason,
      },
      ip: clientIp(req.headers),
      userAgent: ua,
    }, cfg)
  }
  return new NextResponse(null, { status: 204 })
}
