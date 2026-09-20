import WebSocket from 'ws'
import { MAX_AUDIO_SECONDS, REQUEST_TIMEOUT_MS } from './schemas.ts'
import { BYTES_PER_SAMPLE, SAMPLE_RATE } from './wav.ts'

export const GATEWAY = process.env.TTS_GATEWAY_URL || 'https://api.readaloudai.org'

export type ErrorCode = 'unauthorized' | 'payment_required' | 'capacity' | 'invalid_voice' | 'timeout' | 'upstream' | 'rate_limited' | 'invalid_input'

export class UpstreamError extends Error {
  code: ErrorCode
  retryable: boolean
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

/** Exchange the caller's API key for a short-lived session token. The key is used here only, never logged or stored. */
export async function authorize(key: string, engine: string): Promise<{ token: string; url: string }> {
  let r: Response
  try {
    r = await fetch(`${GATEWAY}/tts/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, engine }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the ReadAloud AI API. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'This key has used up its free characters. Add a payment method in the developer console at https://readaloudai.org/developers#get-started, then try again.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'The API is rate limiting this key. Wait a moment and retry.', true)
  if (!r.ok) throw new UpstreamError('upstream', `The ReadAloud AI API returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as { token?: string; url?: string } | null
  if (!body?.token || !body.url || !/^wss?:\/\//.test(body.url)) throw new UpstreamError('upstream', 'Unexpected response from the ReadAloud AI API.', true)
  return { token: body.token, url: body.url }
}

export interface SynthResult { pcm: Buffer; ttfaMs: number; totalMs: number; truncated: boolean }

/** One synthesize request over the WebSocket, collecting PCM until done, the audio cap, or the timeout. */
export function synthesize(opts: { url: string; token: string; text: string; voice: string; speed: number }): Promise<SynthResult> {
  const maxBytes = MAX_AUDIO_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${opts.url}?token=${encodeURIComponent(opts.token)}`, { handshakeTimeout: REQUEST_TIMEOUT_MS })
    const chunks: Buffer[] = []
    let bytes = 0
    let sentAt = 0
    let ttfaMs = -1
    let settled = false

    const finish = (err: UpstreamError | null, truncated = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      if (err) return reject(err)
      let pcm = Buffer.concat(chunks)
      if (pcm.length > maxBytes) { pcm = pcm.subarray(0, maxBytes); truncated = true }
      if (pcm.length === 0) return reject(new UpstreamError('upstream', 'The engine returned no audio.', true))
      resolve({ pcm, ttfaMs: Math.max(ttfaMs, 0), totalMs: Date.now() - sentAt, truncated })
    }
    const timer = setTimeout(() => finish(new UpstreamError('timeout', `Speech generation took longer than ${REQUEST_TIMEOUT_MS / 1000} s.`, true)), REQUEST_TIMEOUT_MS)

    ws.on('open', () => {
      sentAt = Date.now()
      ws.send(JSON.stringify({ type: 'synthesize', text: opts.text, voice: opts.voice, speed: opts.speed }))
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (ttfaMs < 0) ttfaMs = Date.now() - sentAt
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
        chunks.push(buf)
        bytes += buf.length
        if (bytes >= maxBytes) {
          try { ws.send(JSON.stringify({ type: 'stop' })) } catch { /* ignore */ }
          finish(null, true)
        }
        return
      }
      let msg: { type?: string; message?: string }
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.type === 'done' || msg.type === 'cancelled') finish(null)
      else if (msg.type === 'error') {
        const m = msg.message || 'unknown error'
        if (/capacity/i.test(m)) finish(new UpstreamError('capacity', 'The voice server is at capacity. Retry in a few seconds.', true))
        else if (/voice/i.test(m)) finish(new UpstreamError('invalid_voice', `The engine rejected the voice: ${m}. Call list_voices for valid options.`))
        else finish(new UpstreamError('upstream', `Engine error: ${m}`, true))
      }
    })
    ws.on('close', (code) => {
      if (code === 1013) finish(new UpstreamError('capacity', 'The voice server is at capacity. Retry in a few seconds.', true))
      else finish(bytes > 0 ? null : new UpstreamError('upstream', `The connection closed before audio arrived (code ${code}).`, true))
    })
    ws.on('error', (e) => finish(new UpstreamError('upstream', `Could not connect to the voice server (${e.message}). A cold Kokoro worker can need a retry.`, true)))
  })
}

export async function fetchPiperHealth(): Promise<{ active: number; max: number; device?: string; status?: string } | null> {
  try {
    const r = await fetch('https://piper-tts-sjc.fly.dev/health', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}
