import { NextRequest, NextResponse } from 'next/server'
import { parseDemoEvent } from '@/lib/demoEvent'

// Receives anonymous events from the homepage voice demo (what was played, time to first audio, errors) and forwards them to
// PostHog. The typed text is never sent. The key is PostHog's public ingest key (the same one already shipped in the
// calldesk.tech site), so no new secret is needed; POSTHOG_KEY overrides it.
const KEY = process.env.POSTHOG_KEY || 'phc_rusZvdY7jczUGJWzQh2dZneuHN3uEiueYTimkNvNQGLR'
const HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '')
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
  try {
    await fetch(`${HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: KEY,
        event: 'ra_demo',
        distinct_id: `ra-demo-${ev.sid}`,
        properties: {
          $host: 'readaloudai.org',
          $current_url: 'https://readaloudai.org/',
          $ip: ip === 'unknown' ? undefined : ip, // lets PostHog derive country and city; the address itself is not stored by us
          site: 'readaloudai.org',
          kind: ev.kind,
          preset: ev.preset,
          custom_text: ev.preset < 0,
          chars: ev.chars,
          first_audio_ms: ev.firstMs,
          audio_ms: ev.audioMs,
          reason: ev.reason,
        },
      }),
      cache: 'no-store',
    })
  } catch {
    // analytics must never affect the demo
  }
  return new NextResponse(null, { status: 204 })
}
