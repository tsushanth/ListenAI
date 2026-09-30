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

// --------------------------------------------------------------------------
// Voice isolation (Demucs) — proxied through this backend's own Express routes
// (backend/src/routes/voiceIsolate.ts), not a gateway-authorized worker like text_to_speech/speech_to_text.
// Vocal isolation needs backend/Supabase state (per-user Modal deployments, job rows) that only this
// backend has, so the MCP tool calls it directly rather than talking to a worker.
//
// Identity: backend/src/middleware/apiKeyAuth.ts's requireAuthOrApiKey (see MCP_AUTH_BRIDGE.md) accepts a
// gateway-forwarded-secret + resolved-identity header pair in place of a Supabase JWT. We reuse the
// existing /tts/authorize hand-off purely to (a) validate the caller's API key the same way every other
// tool here does, and (b) recover the uid the gateway embeds in the session token it mints, if this key is
// bound to a user. authorize()'s token is never sent to the backend or used to call the TTS engine here —
// only its (unverified, but gateway-issued straight to this process over TLS) `uid` claim is read.
//
// NOT resolved by this branch, flagged in MCP_AUTH_BRIDGE.md as needing a human decision before this ships:
// which secret value MCP_GATEWAY_FORWARD_SECRET should hold in the web deployment's env — the SAME value
// as the backend's GATEWAY_FORWARD_SECRET (simplest, but means a leak of either secret compromises both
// forwarding paths), or a separate secret provisioned to both sides (more correct blast-radius-wise, more
// setup). Defaulting to "same secret" here only because leaving the env var unset makes every isolate_voice
// call fail closed (401) rather than silently using a wrong identity — see the missing-secret behavior in
// requireAuthOrApiKey. This must be revisited before enabling MCP voice isolation in production.
//
// Bare, unbound keys (no uid claim) fall back to this tool's own key-id hash (ctx.keyId, see server.ts) as
// the forwarded identity, NOT the gateway's real internal key id — voiceStudioApiKey.ts's x-gateway-key-id
// fallback is normally the gateway's own record, which this process never sees. That means an unbound key's
// per-user deployment/usage rows are keyed off this hash rather than the gateway's key id; harmless for a
// single MCP server instance, but another reason this whole path is provisional. See MCP_AUTH_BRIDGE.md.
const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'
const MCP_GATEWAY_FORWARD_SECRET = process.env.MCP_GATEWAY_FORWARD_SECRET || ''

/** Best-effort, unverified read of a JWT's payload — safe here only because the token came straight from
 *  our own gateway in direct response to our own authorize() call; we are reading a claim WE just minted a
 *  request for, not trusting an arbitrary bearer token from an external caller. */
function decodeJwtClaim(token: string, claim: string): string | undefined {
  try {
    const part = token.split('.')[1]
    if (!part) return undefined
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const payload = JSON.parse(json) as Record<string, unknown>
    const v = payload[claim]
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

function backendForwardHeaders(uidOrKeyId: { uid?: string; keyId: string }): Record<string, string> {
  const h: Record<string, string> = { 'x-gateway-admin-secret': MCP_GATEWAY_FORWARD_SECRET }
  if (uidOrKeyId.uid) h['x-gateway-uid'] = uidOrKeyId.uid
  else h['x-gateway-key-id'] = uidOrKeyId.keyId
  return h
}

async function resolveBackendIdentity(apiKey: string, keyId: string): Promise<{ uid?: string; keyId: string }> {
  // Piggyback on the same /tts/authorize check every other tool already makes; also surfaces
  // unauthorized/payment_required the same way so isolate_voice's errors stay consistent with the rest.
  const { token } = await authorize(apiKey, 'piper')
  const uid = decodeJwtClaim(token, 'uid')
  return { uid, keyId }
}

export interface IsolationSubmitResult { job_id: string; status: string }

export async function isolateVoice(opts: {
  apiKey: string
  keyId: string
  buffer: Buffer
  mimeType: string
  wantInstrumental: boolean
  timeoutMs: number
}): Promise<IsolationSubmitResult> {
  const identity = await resolveBackendIdentity(opts.apiKey, opts.keyId)
  const form = new FormData()
  form.append('input', new Blob([new Uint8Array(opts.buffer)], { type: opts.mimeType }), 'input')
  form.append(
    'consent_statement',
    'I confirm that I have the legal right to use this audio and that isolating its vocal ' +
    'track does not infringe anyone else\'s rights.'
  )
  form.append('want_instrumental', String(opts.wantInstrumental))

  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/voice-isolate/isolations`, {
      method: 'POST',
      headers: backendForwardHeaders(identity),
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the voice isolation backend. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key, or the isolation backend is not configured to trust this MCP server yet.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'Voice isolation requires an active subscription. Add a payment method in the developer console at https://readaloudai.org/developers#get-started, then try again.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'Too many isolation jobs. Wait a moment and retry.', true)
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new UpstreamError('invalid_input', body?.error || 'The isolation backend rejected the request.')
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new UpstreamError('upstream', `Voice isolation backend returned ${r.status}: ${text}`, r.status >= 500)
  }
  const body = (await r.json().catch(() => null)) as IsolationSubmitResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the voice isolation backend.', true)
  return body
}

export interface IsolationStatusResult { status: string; [key: string]: unknown }

export async function getVoiceIsolationStatus(opts: {
  apiKey: string; keyId: string; jobId: string; timeoutMs: number
}): Promise<IsolationStatusResult> {
  const identity = await resolveBackendIdentity(opts.apiKey, opts.keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/voice-isolate/isolations/${encodeURIComponent(opts.jobId)}`, {
      headers: backendForwardHeaders(identity),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the voice isolation backend. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 404) throw new UpstreamError('invalid_input', 'No isolation job found with that job_id.')
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new UpstreamError('upstream', `Voice isolation backend returned ${r.status}: ${text}`, r.status >= 500)
  }
  const body = (await r.json().catch(() => null)) as IsolationStatusResult | null
  if (!body?.status) throw new UpstreamError('upstream', 'Unexpected response from the voice isolation backend.', true)
  return body
}

export async function getVoiceIsolationAudio(opts: {
  apiKey: string; keyId: string; jobId: string; stem: 'vocals' | 'instrumental'; timeoutMs: number
}): Promise<Buffer> {
  const identity = await resolveBackendIdentity(opts.apiKey, opts.keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/voice-isolate/isolations/${encodeURIComponent(opts.jobId)}/audio?stem=${opts.stem}`, {
      headers: backendForwardHeaders(identity),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the voice isolation backend. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 404) throw new UpstreamError('invalid_input', 'No isolation job found with that job_id, or its result is not ready.')
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new UpstreamError('upstream', `Voice isolation backend returned ${r.status}: ${text}`, r.status >= 500)
  }
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
