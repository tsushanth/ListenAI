import WebSocket from 'ws'
import { MAX_AUDIO_SECONDS, REQUEST_TIMEOUT_MS } from './schemas.ts'
import { deploymentRequiredError } from './deployments.ts'
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

// ----------------------------------------------------------------------------
// Gateway identity bridge — shared by every MCP tool that forwards a call to
// this repo's backend under requireAuthOrApiKey (see MCP_AUTH_BRIDGE.md).
// This used to be reimplemented separately per tool family (isolate_voice,
// dub_audio, generate_sound_effect, and audiobooksClient.ts each had their
// own copy), with subtly different bugs — including a production outage
// (audiobooksClient.ts assumed a 3-part JWT and required a token-carried
// uid/key_id with no fallback; the real 2-part gateway token for that key
// carried neither, so every call 401'd). Consolidated into one implementation
// used everywhere, incorporating the lessons from that outage:
//   - decodeGatewayClaims tries every dot-separated token segment for a JSON
//     payload, rather than assuming a fixed segment index — the gateway
//     token is 2-part (payload.signature), not a standard 3-part JWT.
//   - resolveGatewayIdentity never throws "could not resolve identity": it
//     always has a fallback identity to forward, because keyId here is the
//     caller-supplied ctx.keyId (see server.ts / route.ts), not something
//     this function derives itself.
//
// keyId is passed in by the caller (ctx.keyId, computed once in
// app/mcp/route.ts as sha256(apiKey).slice(0, 16)) rather than re-derived
// here. Before this consolidation, the dub/sound-effects/audiobooks copies
// each self-derived their own sha256(key).slice(0, 32) fallback hash —
// a DIFFERENT value, at a different slice length, than ctx.keyId. That meant
// the same raw key could resolve to two different synthetic identities
// depending on which tool touched it first, splitting a single user's data
// across the backend. Standardizing on the single ctx.keyId the caller
// already has fixes that inconsistency.

/** Best-effort, unverified read of a gateway session token's claims — safe here only because the
 *  token came straight from our own gateway in direct response to our own authorize() call; we are
 *  reading a claim WE just minted a request for, not trusting an arbitrary bearer token from an
 *  external caller. Tries every dot-separated segment rather than assuming a fixed position, since
 *  the real gateway token is 2-part (payload.signature), not a standard 3-part header.payload.signature JWT. */
function decodeGatewayClaims(token: string): Record<string, unknown> {
  for (const segment of token.split('.')) {
    try {
      const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
      const json = Buffer.from(normalized, 'base64').toString('utf8')
      const parsed = JSON.parse(json) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // try the next segment
    }
  }
  return {}
}

/** Exchange the raw API key for a gateway session token and resolve a backend-forwardable identity:
 *  the bound Supabase uid if there is one, else the caller-supplied `keyId` (ctx.keyId). Never throws
 *  "could not resolve identity" — keyId is always available as a guaranteed fallback. */
export async function resolveGatewayIdentity(apiKey: string, keyId: string): Promise<{ uid?: string; keyId: string }> {
  // Piggyback on the same /tts/authorize check every other tool already makes; also surfaces
  // unauthorized/payment_required the same way so every bridged tool's errors stay consistent.
  const { token } = await authorize(apiKey, 'piper')
  const claims = decodeGatewayClaims(token)
  const uid = typeof claims.uid === 'string' && claims.uid ? claims.uid : undefined
  return { uid, keyId }
}

/** Build the `x-gateway-admin-secret` + `x-gateway-uid`/`x-gateway-key-id` headers requireAuthOrApiKey
 *  trusts in place of a Supabase JWT. Does not set Content-Type — callers with a JSON body add that
 *  themselves so this can also be used as-is for multipart/form-data requests (isolate_voice). */
export function gatewayIdentityHeaders(identity: { uid?: string; keyId: string }): Record<string, string> {
  if (!MCP_GATEWAY_FORWARD_SECRET) {
    throw new UpstreamError('upstream', 'This feature is not configured on this deployment (missing MCP_GATEWAY_FORWARD_SECRET).', false)
  }
  const headers: Record<string, string> = { 'x-gateway-admin-secret': MCP_GATEWAY_FORWARD_SECRET }
  if (identity.uid) headers['x-gateway-uid'] = identity.uid
  else headers['x-gateway-key-id'] = identity.keyId
  return headers
}

/** Convenience wrapper: resolve identity and build headers in one call. */
export async function resolveGatewayIdentityHeaders(apiKey: string, keyId: string): Promise<Record<string, string>> {
  return gatewayIdentityHeaders(await resolveGatewayIdentity(apiKey, keyId))
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
  const identity = await resolveGatewayIdentity(opts.apiKey, opts.keyId)
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
      headers: gatewayIdentityHeaders(identity),
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the voice isolation backend. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key, or the isolation backend is not configured to trust this MCP server yet.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'Your free credits are used up (voice isolation). Add a payment method in the developer console at https://readaloudai.org/developers#get-started, then try again.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'Too many isolation jobs. Wait a moment and retry.', true)
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null
    if (body?.code === 'deployment_required') throw deploymentRequiredError('isolate')
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
  const identity = await resolveGatewayIdentity(opts.apiKey, opts.keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/voice-isolate/isolations/${encodeURIComponent(opts.jobId)}`, {
      headers: gatewayIdentityHeaders(identity),
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
  const identity = await resolveGatewayIdentity(opts.apiKey, opts.keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/voice-isolate/isolations/${encodeURIComponent(opts.jobId)}/audio?stem=${opts.stem}`, {
      headers: gatewayIdentityHeaders(identity),
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

/** Same hand-off as authorize() above, but for batch speech-to-text (worker-stt-prod, `mode: "batch"`). */
export async function authorizeStt(key: string): Promise<{ token: string; url: string }> {
  let r: Response
  try {
    r = await fetch(`${GATEWAY}/stt/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, mode: 'batch' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the ReadAloud AI API. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'This key has used up its free characters. Add a payment method in the developer console at https://readaloudai.org/developers#get-started, then try again.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'The API is rate limiting this key. Wait a moment and retry.', true)
  if (r.status === 501) throw new UpstreamError('upstream', 'Speech-to-text is not available right now.', true)
  if (!r.ok) throw new UpstreamError('upstream', `The ReadAloud AI API returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as { token?: string; url?: string } | null
  if (!body?.token || !body.url || !/^https?:\/\//.test(body.url)) throw new UpstreamError('upstream', 'Unexpected response from the ReadAloud AI API.', true)
  return { token: body.token, url: body.url }
}

export interface TranscribeResult {
  text: string
  language: string
  language_probability?: number
  duration: number
  words?: Array<{ word: string; start: number; end: number }>
  segments?: Array<{ id: number; start: number; end: number; text: string }>
}

/** POST decoded audio bytes to worker-stt-prod's `/v1/stt`, authenticated with a freshly minted session token. */
export async function transcribe(opts: {
  url: string
  token: string
  buffer: Buffer
  mimeType: string
  language?: string
  wordTimestamps: boolean
  timeoutMs: number
}): Promise<TranscribeResult> {
  const qs = new URLSearchParams()
  if (opts.language) qs.set('language', opts.language)
  if (opts.wordTimestamps) qs.set('word_timestamps', 'true')

  let r: Response
  try {
    r = await fetch(`${opts.url}/v1/stt?${qs.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': opts.mimeType || 'application/octet-stream' },
      body: new Uint8Array(opts.buffer),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the speech-to-text worker. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Speech-to-text session token was rejected.')
  if (r.status === 413) throw new UpstreamError('invalid_input', 'Audio file is too large.')
  if (r.status === 400) {
    const text = await r.text().catch(() => '')
    throw new UpstreamError('invalid_input', `The worker rejected the audio: ${text || 'bad request'}.`)
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new UpstreamError('upstream', `worker-stt-prod returned ${r.status}: ${text}`, r.status >= 500)
  }
  const body = (await r.json().catch(() => null)) as TranscribeResult | null
  if (!body || typeof body.text !== 'string') throw new UpstreamError('upstream', 'Unexpected response from the speech-to-text worker.', true)
  return body
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
  keyId: string
  audioBase64: string
  filename: string
  targetLanguage: string
  sourceLanguage?: string
  voiceId?: string
}): Promise<DubSubmitResult> {
  const identity = await resolveGatewayIdentity(opts.key, opts.keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...gatewayIdentityHeaders(identity) },
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
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null
    if (body?.code === 'deployment_required') throw deploymentRequiredError('dub')
    throw new UpstreamError('invalid_input', body?.error || 'The dubbing backend rejected the request.', false)
  }
  if (!r.ok) throw new UpstreamError('upstream', `The ReadAloud AI API returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as DubSubmitResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the ReadAloud AI API.', true)
  return body
}

export async function getDubStatus(key: string, keyId: string, jobId: string): Promise<DubStatusResult> {
  const identity = await resolveGatewayIdentity(key, keyId)
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}/api/dub/${encodeURIComponent(jobId)}`, {
      headers: { 'Content-Type': 'application/json', ...gatewayIdentityHeaders(identity) },
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



// ----------------------------------------------------------------------------
// Sound effects — a different upstream than the TTS gateway above.
//
// text_to_speech/list_voices/get_api_status all talk to the realtime-tts
// GATEWAY (api.readaloudai.org) via an API key exchanged for a session
// token (authorize()) then a WebSocket (synthesize()). Sound effects live
// on the ReadAloudAI *backend* instead (backend/src/routes/soundEffects.ts,
// an async job API, mounted behind `requireAuthOrApiKey` — see
// backend/src/middleware/apiKeyAuth.ts and MCP_AUTH_BRIDGE.md), a separate
// service with a separate auth model than the gateway's own session tokens.
//
// This used to forward the MCP caller's raw `apiKey` straight through as a
// Bearer token against the backend, which the backend correctly rejected as
// an invalid JWT (it isn't one). Fixed per MCP_AUTH_BRIDGE.md's "gateway
// identity bridge" pattern — the same one `voiceStudioApiKey.ts` already
// uses in production:
//   1. Exchange the raw key for a session token via the gateway's existing
//      `authorize()` (same call text_to_speech already makes) — this is
//      what actually validates the key; the backend never sees raw key
//      material.
//   2. Decode the resolved identity (the `uid` claim the gateway embeds in
//      the session token, per ttsGatewayClient.ts's `issueGatewayKey`
//      comment — or the token's key id if there's no bound uid) out of that
//      token. The token is not re-verified here: it was just minted by the
//      gateway in step 1 over a fresh, authenticated response, so decoding
//      is trusted the same way the rest of this call chain already trusts
//      that response.
//   3. Forward the backend call with `x-gateway-admin-secret` (proving this
//      is a trusted forwarder, not an arbitrary caller) plus `x-gateway-uid`
//      / `x-gateway-key-id` instead of a fake Bearer token.
//
// GATEWAY_FORWARD_SECRET provisioning: per MCP_AUTH_BRIDGE.md this is a
// human/ops decision, not something to default silently. This reads it from
// `MCP_GATEWAY_FORWARD_SECRET` in the web deployment's env — ops must set it
// to the *same* value as the backend's `GATEWAY_FORWARD_SECRET` (the backend
// middleware checks against one secret; minting a second, MCP-scoped secret
// would need a backend change too, left as the follow-up
// MCP_AUTH_BRIDGE.md's "Everything else" section flags). If it isn't
// configured, sound effect calls fail closed with a clear upstream error
// instead of silently sending a bearer token the backend will reject anyway.
// NOTE: fixed during merge — this defaulted to 'https://api.readaloudai.com' (wrong TLD, and
// the wrong host regardless: /api/sound-effects lives on listenai-backend, not the gateway),
// which doesn't resolve. Matches the working default other MCP upstream calls (dub, audiobooks) use.
const SOUND_EFFECTS_BACKEND_URL = process.env.READALOUD_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export interface SoundEffectJobResult { job_id: string; status: string; cache_hit?: boolean; audio_url?: string; error?: { code: string; message: string } }

export async function submitSoundEffectJob(identityHeaders: Record<string, string>, prompt: string, durationSec: number): Promise<SoundEffectJobResult> {
  let r: Response
  try {
    r = await fetch(`${SOUND_EFFECTS_BACKEND_URL}/api/sound-effects/job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identityHeaders },
      body: JSON.stringify({ prompt, duration_sec: durationSec }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the sound effects service. Try again shortly.', true)
  }
  if (r.status === 401) throw new UpstreamError('unauthorized', 'Invalid or expired credentials for sound effect generation.')
  if (r.status === 402) throw new UpstreamError('payment_required', 'Your free credits are used up (sound effects). Add a payment method at https://readaloudai.org/developers#get-started, then try again.')
  if (r.status === 429) throw new UpstreamError('rate_limited', 'Sound effect generation is being rate limited. Wait a moment and retry.', true)
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { error?: string; code?: string } | null
    if (body?.code === 'deployment_required') throw deploymentRequiredError('sound_effect')
    throw new UpstreamError('invalid_input', body?.error || 'The sound effects service rejected the request.', false)
  }
  if (!r.ok && r.status !== 202) throw new UpstreamError('upstream', `The sound effects service returned ${r.status}.`, r.status >= 500)
  const body = (await r.json().catch(() => null)) as SoundEffectJobResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the sound effects service.', true)
  return body
}

export async function pollSoundEffectJob(identityHeaders: Record<string, string>, jobId: string): Promise<SoundEffectJobResult> {
  let r: Response
  try {
    r = await fetch(`${SOUND_EFFECTS_BACKEND_URL}/api/sound-effects/job/${encodeURIComponent(jobId)}`, {
      headers: identityHeaders,
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
