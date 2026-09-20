import { NextRequest, NextResponse } from 'next/server'

// Mints a short-lived Piper session token for the homepage demo. The demo API key lives only in
// this server's env (TTS_DEMO_API_KEY); the browser never sees it. Piper only: it is the
// always-on CPU engine, so a visitor can't wake a GPU worker.
const GATEWAY = process.env.TTS_GATEWAY_URL || 'https://api.readaloudai.org'
const hits = new Map<string, number[]>()
const LIMIT = 8
const WINDOW_MS = 60_000

export async function POST(req: NextRequest) {
  const key = process.env.TTS_DEMO_API_KEY
  if (!key) return NextResponse.json({ error: 'demo not configured' }, { status: 503 })

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
  const now = Date.now()
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= LIMIT) return NextResponse.json({ error: 'slow down' }, { status: 429 })
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) hits.clear()

  try {
    const r = await fetch(`${GATEWAY}/tts/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, engine: 'piper' }),
      cache: 'no-store',
    })
    if (!r.ok) return NextResponse.json({ error: 'unavailable' }, { status: 503 })
    const { token, url } = await r.json()
    return NextResponse.json({ token, url }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 })
  }
}
