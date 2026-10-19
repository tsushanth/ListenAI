// Web reader TTS on the distilled Piper house voice (custom:en-us-warm-f), the same engine the Android app uses.
// Flow: POST {API}/api/realtime-tts/authorize {engine:'piper'} -> {token, url}; open `${url}?token=...`; send
// {type:'synthesize', text, voice, speed}; the worker answers with chunk_meta JSON, binary 16-bit mono PCM frames and 'done'.
// (The old reader called POST /api/tts, which is served by the self-hosted Kokoro model: about 6x slower.)
// splitText / buildWav are pure so they can be unit-tested without a browser.

export const PIPER_VOICE = 'custom:en-us-warm-f'
const FALLBACK_VOICE = 'default' // the worker's DEFAULT_VOICE, also warm-f; used if a worker does not know the custom id
/** The worker rejects one request over 5,000 characters; stay under it. */
export const MAX_CHUNK_CHARS = 4000
const DEFAULT_SAMPLE_RATE = 24000
const IDLE_TIMEOUT_MS = 30000

/** Split text into pieces of at most `max` characters, preferring paragraph, then sentence, then word boundaries. */
export function splitText(text: string, max = MAX_CHUNK_CHARS): string[] {
  let rest = text.trim()
  const out: string[] = []
  while (rest.length > max) {
    const win = rest.slice(0, max)
    let cut = win.lastIndexOf('\n\n')
    if (cut < max * 0.5) {
      const ends = Array.from(win.matchAll(/[.!?…]["')\]]?\s/g))
      const last = ends[ends.length - 1]
      cut = last && last.index !== undefined ? last.index + last[0].length : -1
    }
    if (cut < max * 0.5) cut = win.lastIndexOf(' ')
    if (cut <= 0) cut = max
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out.filter(Boolean)
}

/** 44-byte RIFF/WAVE header for 16-bit mono PCM. */
export function wavHeader(dataBytes: number, sampleRate: number): Uint8Array {
  const h = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)) }
  tag(0, 'RIFF'); h.setUint32(4, 36 + dataBytes, true); tag(8, 'WAVE')
  tag(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true)
  h.setUint32(24, sampleRate, true); h.setUint32(28, sampleRate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true)
  tag(36, 'data'); h.setUint32(40, dataBytes, true)
  return new Uint8Array(h.buffer)
}

/** Concatenate 16-bit mono PCM frames into one WAV file. */
export function buildWav(pcm: Uint8Array[], sampleRate: number): Uint8Array {
  const total = pcm.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(44 + total)
  out.set(wavHeader(total, sampleRate), 0)
  let at = 44
  for (const c of pcm) { out.set(c, at); at += c.length }
  return out
}

export interface PiperResult { wav: Uint8Array; sampleRate: number; durationSec: number; firstAudioMs: number | null }

/** Synthesize `text` with the Piper house voice. Resolves with a WAV file; rejects with a readable Error. */
export async function synthesizeWithPiper(
  text: string,
  opts: { apiUrl: string; speed?: number; deviceId?: string; signal?: AbortSignal },
): Promise<PiperResult> {
  const pieces = splitText(text)
  if (!pieces.length) throw new Error('Please enter some text to read')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.deviceId) headers['X-Device-ID'] = opts.deviceId
  let auth: { token?: string; url?: string } | null = null
  try {
    const r = await fetch(`${opts.apiUrl}/api/realtime-tts/authorize`, { method: 'POST', headers, body: JSON.stringify({ engine: 'piper' }), signal: opts.signal })
    if (r.status === 429) throw new Error('Too many requests. Please wait a moment and try again.')
    if (!r.ok) throw new Error('The voice service is unavailable right now. Please try again.')
    auth = await r.json()
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || /Too many|unavailable/.test(e.message))) throw e
    throw new Error('Could not reach the voice service. Check your connection and try again.')
  }
  if (!auth?.token || !auth.url) throw new Error('The voice service is unavailable right now. Please try again.')

  return new Promise<PiperResult>((resolve, reject) => {
    const ws = new WebSocket(`${auth!.url}?token=${auth!.token}`)
    ws.binaryType = 'arraybuffer'
    const pcm: Uint8Array[] = []
    let sampleRate = DEFAULT_SAMPLE_RATE
    let index = 0
    let voice = PIPER_VOICE
    let triedFallback = false
    let firstAt: number | null = null
    let settled = false
    const started = performance.now()
    let idle: ReturnType<typeof setTimeout>

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      opts.signal?.removeEventListener('abort', onAbort)
      try { ws.close() } catch { /* already closed */ }
      if (err) return reject(err)
      const wav = buildWav(pcm, sampleRate)
      resolve({ wav, sampleRate, durationSec: (wav.length - 44) / 2 / sampleRate, firstAudioMs: firstAt === null ? null : Math.round(firstAt) })
    }
    const onAbort = () => finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' }))
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => finish(new Error('The voice service timed out. Please try again.')), IDLE_TIMEOUT_MS) }
    const sendCurrent = () => { arm(); ws.send(JSON.stringify({ type: 'synthesize', text: pieces[index], voice, speed: opts.speed ?? 1.0 })) }

    opts.signal?.addEventListener('abort', onAbort)
    arm()
    ws.onopen = sendCurrent
    ws.onerror = () => finish(new Error('Could not reach the voice server. Please try again.'))
    ws.onclose = () => finish(new Error('The voice connection closed before the audio finished.'))
    ws.onmessage = (e) => {
      arm()
      if (typeof e.data !== 'string') {
        if (firstAt === null) firstAt = performance.now() - started
        pcm.push(new Uint8Array(e.data as ArrayBuffer))
        return
      }
      let m: { type?: string; message?: string; sample_rate?: number }
      try { m = JSON.parse(e.data) } catch { return }
      if (m.type === 'chunk_meta' && typeof m.sample_rate === 'number' && m.sample_rate > 0) sampleRate = m.sample_rate
      else if (m.type === 'done') {
        index += 1
        if (index >= pieces.length) finish()
        else sendCurrent()
      } else if (m.type === 'error') {
        if (!triedFallback && pcm.length === 0 && /unknown voice/i.test(m.message ?? '')) { triedFallback = true; voice = FALLBACK_VOICE; sendCurrent(); return }
        finish(new Error(/capacity|busy/i.test(m.message ?? '') ? 'The voice service is busy. Try again in a few seconds.' : 'Something went wrong generating the audio. Please try again.'))
      }
    }
  })
}
