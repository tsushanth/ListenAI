// MCP tools for voice design, voice conversion and Piper voice cloning.
//
// Kept in its own module (schemas + upstream clients together) so server.ts only needs the tool
// registrations. Three different upstreams, deliberately not unified:
//   - voice design / voice conversion: this repo's backend (backend/src/routes/voiceDesign.ts,
//     voiceConvert.ts) behind requireAuthOrApiKey, authenticated with the same gateway-forwarded identity
//     headers as isolate_voice (see upstream.ts's resolveGatewayIdentity / gatewayIdentityHeaders).
//   - voice cloning: the realtime-tts gateway's /v1/voices/* API, which takes the caller's raw API key as a
//     bearer token directly (it validates the key against its own store and forwards to the backend itself).
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import { GATEWAY, UpstreamError, gatewayIdentityHeaders, resolveGatewayIdentity, type ErrorCode } from './upstream.ts'

import { SlidingWindowLimiter } from './ratelimit.ts'

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

// Per-minute limits local to one MCP server instance (mirroring the backend's hourly caps of 12 designs and
// 10 conversions per user). Conversion and design each run a GPU job per call; cloning mutations are rare and
// commit spends real money.
export const designKeyLimiter = new SlidingWindowLimiter(3, 60_000)
export const convertKeyLimiter = new SlidingWindowLimiter(3, 60_000)
export const cloneKeyLimiter = new SlidingWindowLimiter(6, 60_000)

// ============================================================================
// Schemas
// ============================================================================

// The MCP route caps the whole JSON-RPC body at 12 MiB (app/mcp/route.ts MAX_BODY_BYTES); base64 adds ~33%.
export const VOICE_REQUEST_TIMEOUT_MS = 60_000

export const designVoiceInput = {
  description: z.string().trim().min(10, 'description must be at least 10 characters').max(800)
    .describe('Natural-language description of the voice to generate, 10-800 characters, e.g. "A warm, friendly female narrator with a calm British accent".'),
  text: z.string().trim().min(1, 'text must not be empty').max(500)
    .describe('The sample sentence the designed voice will speak, 1-500 characters.'),
}
export const designVoiceSchema = z.object(designVoiceInput)

export const getVoiceDesignInput = {
  job_id: z.string().trim().min(1).max(200).describe('The job_id returned by design_voice.'),
}
export const getVoiceDesignSchema = z.object(getVoiceDesignInput)

// Two clips must both fit, base64-encoded, inside the 12 MiB request body: 2 x 4 MB decoded = ~10.7 MB base64.
export const MAX_CONVERT_AUDIO_MB = 4
export const CONVERT_AUDIO_MIME_TYPES = ['audio/wav', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'] as const

export const convertVoiceInput = {
  source_audio_base64: z.string().min(1)
    .describe(`Base64-encoded speech to convert (WAV, FLAC, OGG, MP3, or M4A), up to ${MAX_CONVERT_AUDIO_MB} MB decoded. Its words and timing are kept.`),
  source_mime_type: z.enum(CONVERT_AUDIO_MIME_TYPES).default('audio/wav').describe('MIME type of the source audio.'),
  target_audio_base64: z.string().min(1)
    .describe(`Base64-encoded reference clip of the voice to convert INTO (same formats), up to ${MAX_CONVERT_AUDIO_MB} MB decoded. A few clean seconds of one speaker works best.`),
  target_mime_type: z.enum(CONVERT_AUDIO_MIME_TYPES).default('audio/wav').describe('MIME type of the target reference audio.'),
  confirms_rights: z.literal(true)
    .describe('Must be true: you confirm you have the legal right to use both the source audio and the target voice reference, and that this conversion does not impersonate any person without their consent.'),
}
export const convertVoiceSchema = z.object(convertVoiceInput)

export const getVoiceConversionInput = {
  job_id: z.string().trim().min(1).max(200).describe('The job_id returned by convert_voice.'),
}
export const getVoiceConversionSchema = z.object(getVoiceConversionInput)

export const VOICE_ID_RE = /^v-[0-9a-f]{10}$/
const voiceIdField = z.string().regex(VOICE_ID_RE, 'voice_id looks like "v-" followed by 10 hex characters')

// Direct base64 upload is bounded by the MCP request body (12 MiB incl. base64 overhead).
export const MAX_CLONE_ZIP_BASE64_MB = 8
// URL uploads are downloaded server-side and forwarded in 8 MB parts.
export const MAX_CLONE_ZIP_URL_MB = 48
export const CLONE_PART_BYTES = 8 * 1024 * 1024

export const createVoiceCloneInput = {
  speaker_name: z.string().trim().min(2).max(100).describe('Full name of the person whose voice is being cloned.'),
  attested_by: z.string().trim().min(2).max(100).describe('Name of the person giving consent (often the same as speaker_name).'),
  consent: z.literal(true)
    .describe('Must be true: the speaker has agreed to have their voice cloned.'),
  consent_statement: z.string().min(1).max(1000)
    .describe('The consent statement, echoed VERBATIM. It is: "I am authorized to consent on behalf of the speaker named in this request, and that speaker has agreed to have their voice cloned and used to synthesize new speech through this service." (the server rejects any other wording and returns the current text if it changes).'),
}
export const createVoiceCloneSchema = z.object(createVoiceCloneInput)

export const uploadVoiceCloneDatasetInput = {
  voice_id: voiceIdField.describe('The voice id returned by create_voice_clone.'),
  zip_base64: z.string().min(1).optional()
    .describe(`Base64-encoded ZIP of the recordings (WAV/FLAC/MP3, one speaker, 10-60 minutes total is ideal), up to ${MAX_CLONE_ZIP_BASE64_MB} MB decoded. Use zip_url instead for anything larger.`),
  zip_url: z.string().url().max(2048).optional()
    .describe(`Alternative to zip_base64: a public https URL of the ZIP, up to ${MAX_CLONE_ZIP_URL_MB} MB. It is downloaded by the server (private/internal addresses are refused). Provide exactly one of zip_base64 or zip_url.`),
}
export const uploadVoiceCloneDatasetSchema = z.object(uploadVoiceCloneDatasetInput)

export const commitVoiceCloneDatasetInput = {
  voice_id: voiceIdField.describe('The voice id whose recordings were uploaded with upload_voice_clone_dataset.'),
  confirms_charge: z.literal(true)
    .describe('Must be true: you understand this starts training and bills $2.50 to the account behind this API key (one-time, per voice).'),
}
export const commitVoiceCloneDatasetSchema = z.object(commitVoiceCloneDatasetInput)

export const voiceCloneIdInput = {
  voice_id: voiceIdField.describe('The voice id returned by create_voice_clone.'),
}
export const voiceCloneIdSchema = z.object(voiceCloneIdInput)

// ============================================================================
// Shared helpers
// ============================================================================

const INVALID_KEY = 'Invalid or revoked API key, or the backend is not configured to trust this MCP server yet.'

async function readErrorMessage(r: Response): Promise<string | undefined> {
  const body = (await r.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  if (typeof body?.error === 'string') return body.error
  if (typeof body?.message === 'string') return body.message
  return undefined
}

/** Maps an unsuccessful backend/gateway response to the shared ErrorCode scheme. Always throws. */
async function throwForStatus(r: Response, what: string, opts: { notFound?: string } = {}): Promise<never> {
  const msg = await readErrorMessage(r)
  const map: Array<[number, ErrorCode, string, boolean]> = [
    [401, 'unauthorized', INVALID_KEY, false],
    [402, 'payment_required', msg || `${what} requires an active subscription. Add a payment method in the developer console at https://readaloudai.org/developers#get-started, then try again.`, false],
    [429, 'rate_limited', msg || `Too many ${what} requests. Wait a moment and retry.`, true],
  ]
  for (const [status, code, message, retryable] of map) {
    if (r.status === status) throw new UpstreamError(code, message, retryable)
  }
  if (r.status === 404) throw new UpstreamError(opts.notFound ? 'invalid_input' : 'upstream', opts.notFound || `${what} is not available on this deployment.`, false)
  if (r.status === 400 || r.status === 409 || r.status === 413 || r.status === 422) {
    throw new UpstreamError('invalid_input', msg || `${what} rejected the request.`, false)
  }
  throw new UpstreamError('upstream', `${what} returned ${r.status}${msg ? `: ${msg}` : ''}`, r.status >= 500)
}

async function backendFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(VOICE_REQUEST_TIMEOUT_MS) })
  } catch {
    throw new UpstreamError('upstream', `Could not reach the ${what} backend. Try again shortly.`, true)
  }
}

// ============================================================================
// Voice design (backend /api/voice-design)
// ============================================================================

export interface VoiceJobResult { job_id: string; status: string }
export interface VoiceStatusResult { status: string; [key: string]: unknown }

export async function submitVoiceDesign(opts: { apiKey: string; keyId: string; description: string; text: string }): Promise<VoiceJobResult> {
  const headers = { 'Content-Type': 'application/json', ...gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId)) }
  const r = await backendFetch(`${BACKEND_URL}/api/voice-design/designs`, {
    method: 'POST', headers, body: JSON.stringify({ description: opts.description, text: opts.text }),
  }, 'voice design')
  if (!r.ok) await throwForStatus(r, 'Voice design')
  const body = (await r.json().catch(() => null)) as VoiceJobResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the voice design backend.', true)
  return body
}

export async function getVoiceDesignStatus(opts: { apiKey: string; keyId: string; jobId: string }): Promise<VoiceStatusResult> {
  const headers = gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId))
  const r = await backendFetch(`${BACKEND_URL}/api/voice-design/designs/${encodeURIComponent(opts.jobId)}`, { headers }, 'voice design')
  if (!r.ok) await throwForStatus(r, 'Voice design', { notFound: 'No voice design job found with that job_id.' })
  const body = (await r.json().catch(() => null)) as VoiceStatusResult | null
  if (!body?.status) throw new UpstreamError('upstream', 'Unexpected response from the voice design backend.', true)
  return body
}

export async function getVoiceDesignAudio(opts: { apiKey: string; keyId: string; jobId: string }): Promise<Buffer> {
  const headers = gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId))
  const r = await backendFetch(`${BACKEND_URL}/api/voice-design/designs/${encodeURIComponent(opts.jobId)}/audio`, { headers }, 'voice design')
  if (!r.ok) await throwForStatus(r, 'Voice design', { notFound: 'No voice design result found for that job_id.' })
  return Buffer.from(await r.arrayBuffer())
}

// ============================================================================
// Voice conversion (backend /api/voice-convert)
// ============================================================================

const CONVERT_CONSENT_STATEMENT =
  'I confirm that I have the legal right to use both the source audio and the target voice reference, ' +
  'and that this conversion does not impersonate any person without their consent.'

const DEPLOY_WAIT_MESSAGE =
  'Voice conversion runs on a private GPU converter that is set up on your first use. It is being provisioned now (about 3 minutes); call convert_voice again then.'

/** API-key callers have no browser to click "Deploy". The backend's POST /deploy is itself reachable via the
 *  bridge, so on a 'deployment_required' response we kick it off (or find it already running) and tell the
 *  caller to retry. A previously failed deployment is torn down and redeployed once. Always throws. */
async function provisionConverterAndAsk(headers: Record<string, string>): Promise<never> {
  const deploy = () => backendFetch(`${BACKEND_URL}/api/voice-convert/deploy`, { method: 'POST', headers }, 'voice conversion')
  let r = await deploy()
  if (r.status === 409) {
    const body = (await r.json().catch(() => null)) as { deployment?: { status?: string } } | null
    if (body?.deployment?.status === 'failed') {
      await backendFetch(`${BACKEND_URL}/api/voice-convert/deploy`, { method: 'DELETE', headers }, 'voice conversion')
      r = await deploy()
    } else {
      throw new UpstreamError('capacity', DEPLOY_WAIT_MESSAGE, true)
    }
  }
  if (r.status === 202 || r.status === 409) throw new UpstreamError('capacity', DEPLOY_WAIT_MESSAGE, true)
  if (r.status === 503) throw new UpstreamError('upstream', 'Voice conversion is not available on this deployment (converter provisioning is not configured).', false)
  await throwForStatus(r, 'Voice conversion')
  throw new UpstreamError('upstream', 'Unexpected response while provisioning the voice converter.', true)
}

export async function submitVoiceConversion(opts: {
  apiKey: string; keyId: string
  source: Buffer; sourceMime: string; target: Buffer; targetMime: string
}): Promise<VoiceJobResult> {
  const headers = gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId))
  const form = new FormData()
  form.append('source', new Blob([new Uint8Array(opts.source)], { type: opts.sourceMime }), 'source')
  form.append('target', new Blob([new Uint8Array(opts.target)], { type: opts.targetMime }), 'target')
  form.append('consent_statement', CONVERT_CONSENT_STATEMENT)
  const r = await backendFetch(`${BACKEND_URL}/api/voice-convert/conversions`, { method: 'POST', headers, body: form }, 'voice conversion')
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { code?: string; error?: string } | null
    if (body?.code === 'deployment_required') return provisionConverterAndAsk(headers)
    throw new UpstreamError('invalid_input', body?.error || 'The voice conversion backend rejected the request.', false)
  }
  if (!r.ok) await throwForStatus(r, 'Voice conversion')
  const body = (await r.json().catch(() => null)) as VoiceJobResult | null
  if (!body?.job_id) throw new UpstreamError('upstream', 'Unexpected response from the voice conversion backend.', true)
  return body
}

export async function getVoiceConversionStatus(opts: { apiKey: string; keyId: string; jobId: string }): Promise<VoiceStatusResult> {
  const headers = gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId))
  const r = await backendFetch(`${BACKEND_URL}/api/voice-convert/conversions/${encodeURIComponent(opts.jobId)}`, { headers }, 'voice conversion')
  if (r.status === 400) {
    const body = (await r.json().catch(() => null)) as { code?: string } | null
    if (body?.code === 'deployment_required') throw new UpstreamError('invalid_input', 'No voice conversion job found for this account. Submit one with convert_voice first.', false)
  }
  if (!r.ok) await throwForStatus(r, 'Voice conversion', { notFound: 'No voice conversion job found with that job_id.' })
  const body = (await r.json().catch(() => null)) as VoiceStatusResult | null
  if (!body?.status) throw new UpstreamError('upstream', 'Unexpected response from the voice conversion backend.', true)
  return body
}

export async function getVoiceConversionAudio(opts: { apiKey: string; keyId: string; jobId: string }): Promise<Buffer> {
  const headers = gatewayIdentityHeaders(await resolveGatewayIdentity(opts.apiKey, opts.keyId))
  const r = await backendFetch(`${BACKEND_URL}/api/voice-convert/conversions/${encodeURIComponent(opts.jobId)}/audio`, { headers }, 'voice conversion')
  if (!r.ok) await throwForStatus(r, 'Voice conversion', { notFound: 'No voice conversion result found for that job_id.' })
  return Buffer.from(await r.arrayBuffer())
}

// ============================================================================
// Voice cloning (realtime-tts gateway /v1/voices, Piper fine-tune, $2.50 per voice)
// ============================================================================

export interface VoiceCloneRecord { id: string; status?: string; [key: string]: unknown }

async function cloneFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<Response> {
  return backendFetch(`${GATEWAY}/v1/voices${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
  }, 'voice cloning')
}

const CLONE_NOT_FOUND = 'No voice found with that voice_id for this API key.'

/** Fetches the current consent wording from the service (GET /v1/voices/enabled). */
export async function getCloneConsent(apiKey: string): Promise<{ version: string; statement?: string }> {
  const r = await cloneFetch(apiKey, '/enabled')
  if (!r.ok) await throwForStatus(r, 'Voice cloning')
  const body = (await r.json().catch(() => null)) as { consent_text_version?: string; consent_statement?: string } | null
  if (!body?.consent_text_version) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { version: body.consent_text_version, statement: body.consent_statement }
}

export async function createVoiceClone(opts: { apiKey: string; speakerName: string; attestedBy: string; consentStatement: string }): Promise<{ id: string }> {
  const consent = await getCloneConsent(opts.apiKey)
  // The wording can change (it is versioned server-side). Check here so the caller gets the current text back
  // instead of an opaque 400 - they still have to send it themselves, verbatim.
  if (consent.statement && opts.consentStatement !== consent.statement) {
    throw new UpstreamError('invalid_input', `consent_statement must echo the current consent text exactly: "${consent.statement}"`, false)
  }
  const r = await cloneFetch(opts.apiKey, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      speaker_name: opts.speakerName,
      attested_by: opts.attestedBy,
      consent: true,
      consent_text_version: consent.version,
      ...(consent.statement ? { consent_statement: opts.consentStatement } : {}),
    }),
  })
  if (!r.ok) await throwForStatus(r, 'Voice cloning')
  const body = (await r.json().catch(() => null)) as { id?: string } | null
  if (!body?.id) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { id: body.id }
}

/** Uploads a dataset ZIP as sequential <=8 MB parts (the documented single-shot PUT is not routed by the backend
 *  yet, the chunked parts path is what the web client uses). Returns the part count for the commit. */
export async function uploadVoiceCloneDataset(opts: { apiKey: string; voiceId: string; zip: Buffer }): Promise<{ parts: number; bytes: number }> {
  const parts = Math.ceil(opts.zip.length / CLONE_PART_BYTES)
  for (let n = 0; n < parts; n++) {
    const chunk = opts.zip.subarray(n * CLONE_PART_BYTES, (n + 1) * CLONE_PART_BYTES)
    const r = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}/dataset/parts/${n}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(chunk),
    })
    if (!r.ok) await throwForStatus(r, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
  }
  return { parts, bytes: opts.zip.length }
}

/** Joins the uploaded parts and starts training (this is the billed step). Part count comes from the service. */
export async function commitVoiceCloneDataset(opts: { apiKey: string; voiceId: string }): Promise<{ id: string; status: string; clips?: number; parts: number }> {
  const listed = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}/dataset/parts`)
  if (!listed.ok) await throwForStatus(listed, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
  const listBody = (await listed.json().catch(() => null)) as { parts?: Array<{ part: number }> } | null
  const have = new Set((listBody?.parts ?? []).map((p) => p.part))
  if (have.size === 0) throw new UpstreamError('invalid_input', 'No recordings uploaded for this voice yet. Call upload_voice_clone_dataset first.', false)
  const count = Math.max(...Array.from(have)) + 1
  for (let i = 0; i < count; i++) {
    if (!have.has(i)) throw new UpstreamError('invalid_input', `Upload is incomplete (part ${i} is missing). Call upload_voice_clone_dataset again with the full ZIP.`, false)
  }
  const r = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}/dataset/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: count }),
  })
  if (!r.ok) await throwForStatus(r, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
  const body = (await r.json().catch(() => null)) as { id?: string; status?: string; clips?: number } | null
  if (!body?.id) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { id: body.id, status: body.status ?? 'training', clips: body.clips, parts: count }
}

export async function getVoiceCloneStatus(opts: { apiKey: string; voiceId: string }): Promise<VoiceCloneRecord> {
  const r = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}`)
  if (!r.ok) await throwForStatus(r, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
  const body = (await r.json().catch(() => null)) as Record<string, unknown> | null
  const id = typeof body?.id === 'string' ? body.id : typeof body?.voice_id === 'string' ? body.voice_id : undefined
  if (!body || !id) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { ...body, id }
}

export async function deployVoiceClone(opts: { apiKey: string; voiceId: string }): Promise<{ id: string; voice: string }> {
  const r = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}/deploy`, { method: 'POST' })
  if (!r.ok) await throwForStatus(r, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
  const body = (await r.json().catch(() => null)) as { id?: string; voice?: string } | null
  if (!body?.voice) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { id: body.id ?? opts.voiceId, voice: body.voice }
}

export async function deleteVoiceClone(opts: { apiKey: string; voiceId: string }): Promise<void> {
  const r = await cloneFetch(opts.apiKey, `/${encodeURIComponent(opts.voiceId)}`, { method: 'DELETE' })
  if (!r.ok) await throwForStatus(r, 'Voice cloning', { notFound: CLONE_NOT_FOUND })
}

// ============================================================================
// Dataset download by URL (SSRF-guarded)
// ============================================================================

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  if (kind === 6) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    if (mapped) return isPrivateAddress(mapped[1])
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('64:ff9b') || v.startsWith('2001:db8')
  }
  return true // not an IP at all: refuse
}

/** Downloads a ZIP from a public https URL, refusing internal addresses, redirects and oversize bodies. */
export async function downloadZip(rawUrl: string, maxBytes = MAX_CLONE_ZIP_URL_MB * 1024 * 1024): Promise<Buffer> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new UpstreamError('invalid_input', 'zip_url is not a valid URL.', false) }
  if (url.protocol !== 'https:') throw new UpstreamError('invalid_input', 'zip_url must be an https URL.', false)
  if (url.username || url.password) throw new UpstreamError('invalid_input', 'zip_url must not contain credentials.', false)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addrs: string[]
  try {
    addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  } catch {
    throw new UpstreamError('invalid_input', 'zip_url host could not be resolved.', false)
  }
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
    throw new UpstreamError('invalid_input', 'zip_url must point to a public host.', false)
  }
  let r: Response
  try {
    // redirect: 'error' - a redirect could otherwise hop to an internal address after the check above.
    r = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000) })
  } catch {
    throw new UpstreamError('invalid_input', 'Could not download zip_url (network error, timeout, or it redirected).', false)
  }
  if (!r.ok || !r.body) throw new UpstreamError('invalid_input', `Downloading zip_url failed with HTTP ${r.status}.`, false)
  const declared = Number(r.headers.get('content-length') || 0)
  if (declared > maxBytes) throw new UpstreamError('invalid_input', `zip_url is larger than ${Math.round(maxBytes / 1048576)} MB.`, false)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = r.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new UpstreamError('invalid_input', `zip_url is larger than ${Math.round(maxBytes / 1048576)} MB.`, false)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** ZIP local-file-header magic ("PK\x03\x04", or "PK\x05\x06" for an empty archive). */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)
}
