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

// ----------------------------------------------------------------------------
// Sound effects — a different upstream than the TTS gateway above.
//
// text_to_speech/list_voices/get_api_status all talk to the realtime-tts
// GATEWAY (api.readaloudai.org) via an API key exchanged for a session
// token (authorize()) then a WebSocket (synthesize()). Sound effects live
// on the ReadAloudAI *backend* instead (backend/src/routes/soundEffects.ts,
// an async job API, mounted behind Express `requireAuth`), a separate
// service with a separate auth model: requireAuth expects a Supabase user
// access token in the Authorization header, not a realtime-tts gateway API
// key. There is no code today that exchanges one for the other.
//
// KNOWN LIMITATION (flagged in the top-level report, not silently papered
// over): this passes the MCP caller's `apiKey` straight through as a Bearer
// token against the ReadAloudAI backend. That only works if the caller's
// "API key" happens to already be a valid Supabase access token for the
// same user — true for nothing today. Wiring this up for real needs either
// a persistent-API-key mechanism on the ReadAloudAI backend (the same gap
// textToMusic.ts's own top-of-file comment flags for itself) or a token-
// exchange step here. Left as-is (rather than inventing a fake bridge)
// so this is visibly a TODO instead of a silently-broken "works in the
// demo" path.
const SOUND_EFFECTS_BACKEND_URL = process.env.READALOUD_BACKEND_URL || 'https://api.readaloudai.com'

export interface SoundEffectJobResult { job_id: string; status: string; cache_hit?: boolean; audio_url?: string; error?: { code: string; message: string } }

export async function submitSoundEffectJob(apiKey: string, prompt: string, durationSec: number): Promise<SoundEffectJobResult> {
  let r: Response
  try {
    r = await fetch(`${SOUND_EFFECTS_BACKEND_URL}/api/sound-effects/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ prompt, duration_sec: durationSec }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the sound effects service. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or expired credentials for sound effect generation.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'Sound effect generation requires an active subscription.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'Sound effect generation is being rate limited. Wait a moment and retry.', true)
  if (!r.ok && r.status !== 202) throw new UpstreamError('upstream', `The sound effects service returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as SoundEffectJobResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the sound effects service.', true)
  return body
}

export async function pollSoundEffectJob(apiKey: string, jobId: string): Promise<SoundEffectJobResult> {
  let r: Response
  try {
    r = await fetch(`${SOUND_EFFECTS_BACKEND_URL}/api/sound-effects/job/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the sound effects service while polling. Try again shortly.', true)
  }
  if (!r.ok) throw new UpstreamError('upstream', `The sound effects service returned ${r.status} while polling.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as SoundEffectJobResult | null
  if (!body?.status) throw new UpstreamError('upstream', 'Unexpected response from the sound effects service while polling.', true)
  return body
}

export async function fetchAudioBytes(url: string): Promise<Buffer> {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new UpstreamError('upstream', `Could not download generated audio (${r.status}).`, true)
  return Buffer.from(await r.arrayBuffer())
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
