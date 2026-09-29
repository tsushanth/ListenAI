import WebSocket from 'ws'
import { createHash } from 'node:crypto'
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

// ============================================================================
// Dubbing (v1)
// ============================================================================
//
// There is no `/dub` route on the realtime-tts gateway, and there never needs
// to be one: the backend's POST /api/dub now accepts the same
// gateway-forwarded-identity pattern voiceStudioApiKey.ts pioneered and
// requireAuthOrApiKey (backend/src/middleware/apiKeyAuth.ts) generalizes. So
// instead of proxying through the gateway, we:
//   1. Validate the raw key against the gateway's existing /tts/authorize
//      (the only key-validation endpoint that exists) to confirm it's live
//      and pull the bound Supabase uid out of the session token it returns
//      (ttsGatewayClient.ts embeds it as the `uid` claim).
//   2. Call the backend's real `/api/dub` directly, forwarding
//      `x-gateway-admin-secret` (MCP_GATEWAY_FORWARD_SECRET) plus
//      `x-gateway-uid` (or `x-gateway-key-id` when the key has no bound uid)
//      so requireAuthOrApiKey resolves an identity without ever seeing a JWT.
//
// MCP_GATEWAY_FORWARD_SECRET is deliberately a *separate* secret from the
// gateway's own GATEWAY_FORWARD_SECRET (per MCP_AUTH_BRIDGE.md's blast-radius
// note) — provision it to both the backend and this web deployment's
// environment before enabling this in production. Until it's provisioned,
// calls below fail closed with an `upstream` error rather than silently
// forwarding an unauthenticated request.

export const BACKEND_URL = process.env.DUB_BACKEND_URL || process.env.BACKEND_URL || 'https://api.readaloudai.org'
const MCP_GATEWAY_FORWARD_SECRET = process.env.MCP_GATEWAY_FORWARD_SECRET

/** Decode the `uid` claim from a gateway session token without verifying its signature — the token was
 *  just fetched directly from the gateway over this same authorize() call, so we already trust its origin;
 *  this only extracts the payload, it isn't an independent trust boundary. */
function decodeGatewayUid(token: string): string | undefined {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return undefined
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json) as { uid?: string }
    return typeof payload.uid === 'string' ? payload.uid : undefined
  } catch {
    return undefined
  }
}

/** Validate the raw API key against the gateway and resolve a backend-forwardable identity: the bound
 *  Supabase uid if there is one, else a synthetic key-id identity derived from the key itself. */
async function resolveGatewayIdentity(key: string): Promise<{ uid?: string; keyId: string }> {
  const { token } = await authorize(key, 'piper')
  const uid = decodeGatewayUid(token)
  // No real gateway key id is exposed to this process; fall back to a stable per-key identity derived
  // from the key so requests from the same key still map to the same backend user when there's no bound uid.
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return { uid, keyId }
}

function forwardHeaders(identity: { uid?: string; keyId: string }): Record<string, string> {
  if (!MCP_GATEWAY_FORWARD_SECRET) {
    throw new UpstreamError('upstream', 'Dubbing is not configured on this deployment (missing MCP_GATEWAY_FORWARD_SECRET).', false)
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-gateway-admin-secret': MCP_GATEWAY_FORWARD_SECRET,
  }
  if (identity.uid) headers['x-gateway-uid'] = identity.uid
  else headers['x-gateway-key-id'] = identity.keyId
  return headers
}

export interface DubSubmitResult { job_id: string; status: string }
export interface DubStatusResult {
  job_id: string
  status: 'processing' | 'ready' | 'failed'
  audio_url?: string
  segments?: unknown[]
  error?: string
}

export async function submitDub(opts: {
  key: string
  audioBase64: string
  filename: string
  targetLanguage: string
  sourceLanguage?: string
  voiceId?: string
}): Promise<DubSubmitResult> {
  const identity = await resolveGatewayIdentity(opts.key)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/dub`, {
      method: 'POST',
      headers: forwardHeaders(identity),
      body: JSON.stringify({
        audio_base64: opts.audioBase64,
        filename: opts.filename,
        target_language: opts.targetLanguage,
        source_language: opts.sourceLanguage,
        voice_id: opts.voiceId,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the ReadAloud AI API. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'This key has used up its free characters.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'The API is rate limiting this key. Wait a moment and retry.', true)
  if (r.status === 404) throw new UpstreamError('upstream', 'Dubbing is not available yet on this deployment.', false)
  if (!r.ok) throw new UpstreamError('upstream', `The ReadAloud AI API returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as DubSubmitResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the ReadAloud AI API.', true)
  return body
}

export async function getDubStatus(key: string, jobId: string): Promise<DubStatusResult> {
  const identity = await resolveGatewayIdentity(key)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/dub/${encodeURIComponent(jobId)}`, {
      headers: forwardHeaders(identity),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the ReadAloud AI API. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 404) throw new UpstreamError('upstream', 'Dubbing job not found (it may have expired).', false)
  if (!r.ok) throw new UpstreamError('upstream', `The ReadAloud AI API returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as DubStatusResult | null
  if (!body?.job_id || !body.status) throw new UpstreamError('upstream', 'Unexpected response from the ReadAloud AI API.', true)
  return body
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
