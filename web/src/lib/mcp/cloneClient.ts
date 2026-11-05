// Client for the consent-gated instant voice cloning API (backend/src/routes/voiceCloneApiKey.ts, mounted at
// /internal/voice-clone-api). Used by the MCP tools (server.ts) and by the public REST routes
// (app/api/v1/voice-clones/*, lib/mcp/voiceCloneRest.ts).
//
// Not to be confused with the older "custom voice" training flow in voiceTools.ts (create_voice_clone,
// upload_voice_clone_dataset, ... talk to the gateway's /v1/voices and train a fine-tuned voice from a ZIP of
// recordings). This one clones from a short reference clip plus a recording of the speaker reading a phrase the
// server issued, and verifies that the voice in the two recordings is the same person.
//
// Identity: the caller's API key is validated against the gateway (authorize) and the bound account is passed to the
// backend as gateway-forwarded headers, exactly like dub_audio / voice design (see upstream.ts and
// MCP_AUTH_BRIDGE.md). The backend refuses keys with no bound account. The key itself is never sent to the
// backend, logged or stored, and no audio is logged here.
import { z } from 'zod'
import { UpstreamError, gatewayIdentityHeaders, resolveGatewayIdentity } from './upstream.ts'
import { downloadPublicFile } from './voiceTools.ts'
import { SlidingWindowLimiter } from './ratelimit.ts'

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'
const API = `${BACKEND_URL}/internal/voice-clone-api`

/** Per key, per server instance. The backend enforces its own hourly caps and the daily creation limit on top. */
export const cloneCreateLimiter = new SlidingWindowLimiter(6, 60_000)
export const cloneSpeechLimiter = new SlidingWindowLimiter(10, 60_000)

export const CLONE_MAX_AUDIO_MB = 25 // backend multer limit per recording
/** MCP carries audio inline in the JSON-RPC body, which the route caps at 12 MiB (base64 adds ~33%), for both clips together. */
export const CLONE_MCP_MAX_BASE64_AUDIO_MB = 4
export const CLONE_SPEECH_MAX_CHARS = 1000 // text_to_speech's own cap; the backend allows 1500
const CONTROL_TIMEOUT_MS = 20_000
/** Creation runs quality checks, speech recognition and speaker matching, and can wake a cold GPU app (up to ~3 minutes). */
const HEAVY_TIMEOUT_MS = 240_000

export const AUDIO_MIME_TYPES = [
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm',
] as const
const mimeSchema = z.enum(AUDIO_MIME_TYPES)

export const CLONE_VOICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** How a cloned voice is named wherever a voice id is accepted (text_to_speech): "clone:<uuid>". A bare uuid is also accepted. */
export const CLONE_VOICE_PREFIX = 'clone:'
/** Returns the cloned-voice uuid if `voice` names one, else null (built-in "default", "af_heart", "custom:<id>" never match). */
export function parseCloneVoiceId(voice: string | undefined): string | null {
  if (!voice) return null
  const v = voice.trim()
  const id = v.toLowerCase().startsWith(CLONE_VOICE_PREFIX) ? v.slice(CLONE_VOICE_PREFIX.length) : v
  return CLONE_VOICE_ID_RE.test(id) ? id.toLowerCase() : null
}

// ----------------------------------------------------------------------------
// Input schemas (shared by the MCP tools and the REST JSON body)
// ----------------------------------------------------------------------------

export const issueConsentPhraseInput = {}

export const createClonedVoiceInput = {
  name: z.string().trim().min(1).max(100).default('My cloned voice')
    .describe('A label for the voice, 1-100 characters.'),
  language: z.string().trim().min(2).max(5).default('en')
    .describe('Language of the voice, e.g. "en", "es", "fr", "de", "ja". Chatterbox Multilingual supports 23 languages.'),
  reference_audio_base64: z.string().min(1).optional()
    .describe(`The reference recording of the speaker, base64 (8-120 s of clean speech by ONE person; up to ${CLONE_MCP_MAX_BASE64_AUDIO_MB} MB decoded). Give this or reference_audio_url.`),
  reference_audio_url: z.string().url().max(2048).optional()
    .describe(`Public https URL of the reference recording (up to ${CLONE_MAX_AUDIO_MB} MB). Give this or reference_audio_base64.`),
  reference_mime_type: mimeSchema.optional()
    .describe('MIME type of the reference recording. Detected from the file when omitted.'),
  challenge_id: z.string().uuid().optional()
    .describe('The challenge_id returned by readaloud_issue_consent_phrase. Required unless the service is in attestation mode (check consent_required).'),
  consent_audio_base64: z.string().min(1).optional()
    .describe(`A recording of the SPEAKER reading the issued consent phrase aloud, base64 (3-40 s, up to ${CLONE_MCP_MAX_BASE64_AUDIO_MB} MB decoded). Give this or consent_audio_url.`),
  consent_audio_url: z.string().url().max(2048).optional()
    .describe(`Public https URL of the consent recording (up to ${CLONE_MAX_AUDIO_MB} MB). Give this or consent_audio_base64.`),
  consent_mime_type: mimeSchema.optional()
    .describe('MIME type of the consent recording. Detected from the file when omitted.'),
  attested: z.boolean().optional()
    .describe('Only for deployments in attestation mode (readaloud_issue_consent_phrase says consent_required is false): true confirms this is your own voice or you have the speaker\'s permission. Ignored, and no bypass, when a consent recording is required.'),
}
export const createClonedVoiceSchema = z.object(createClonedVoiceInput)
export type CreateClonedVoiceArgs = z.infer<typeof createClonedVoiceSchema>

export const clonedVoiceIdInput = {
  voice_id: z.string().regex(CLONE_VOICE_ID_RE, 'voice_id must be a cloned voice id (a UUID) from readaloud_create_voice_clone or readaloud_list_voices').describe('The cloned voice id (a UUID).'),
}
export const clonedVoiceIdSchema = z.object(clonedVoiceIdInput)

// ----------------------------------------------------------------------------
// Audio helpers
// ----------------------------------------------------------------------------

export interface AudioBlob { bytes: Buffer; mime: string; filename: string }

const EXT: Record<string, string> = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a', 'audio/webm': 'webm',
}

/** Best-effort container detection from magic bytes, so a caller does not have to say what they uploaded. */
export function sniffAudioMime(b: Buffer): string | null {
  if (b.length < 12) return null
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1')
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav'
  if (ascii(0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'
  return null
}

export function makeAudio(bytes: Buffer, label: string, mime?: string): AudioBlob {
  if (bytes.length === 0) throw new UpstreamError('invalid_input', `${label} is empty.`, false)
  if (bytes.length > CLONE_MAX_AUDIO_MB * 1024 * 1024) throw new UpstreamError('invalid_input', `${label} is larger than ${CLONE_MAX_AUDIO_MB} MB.`, false)
  const m = mime ?? sniffAudioMime(bytes)
  if (!m) throw new UpstreamError('invalid_input', `Could not recognise the audio format of ${label}. Use WAV, FLAC, OGG, MP3, M4A or WebM, or set its MIME type.`, false)
  return { bytes, mime: m, filename: `${label}.${EXT[m] ?? 'bin'}` }
}

/** Resolves "exactly one of base64 / url" into audio bytes. `maxBase64Mb` bounds inline audio (the transport differs: MCP vs REST). */
export async function resolveAudioInput(o: { label: string; base64?: string; url?: string; mime?: string; maxBase64Mb: number }): Promise<AudioBlob | null> {
  const argBase = `${o.label}_audio`
  if (o.base64 && o.url) throw new UpstreamError('invalid_input', `Provide only one of ${argBase}_base64 or ${argBase}_url.`, false)
  if (!o.base64 && !o.url) return null
  let bytes: Buffer
  if (o.base64) {
    if (Math.floor((o.base64.length * 3) / 4) > o.maxBase64Mb * 1024 * 1024) {
      throw new UpstreamError('invalid_input', `${argBase}_base64 exceeds ${o.maxBase64Mb} MB decoded. Host the file at an https URL and pass ${argBase}_url instead.`, false)
    }
    bytes = Buffer.from(o.base64, 'base64')
  } else {
    bytes = await downloadPublicFile(o.url as string, CLONE_MAX_AUDIO_MB * 1024 * 1024, `${argBase}_url`)
  }
  return makeAudio(bytes, o.label, o.mime)
}

// ----------------------------------------------------------------------------
// Backend calls
// ----------------------------------------------------------------------------

interface ErrBody { error?: unknown; code?: unknown; details?: unknown }

/** Calls the backend with the caller's gateway-forwarded identity. Throws UpstreamError for key problems and network failures only. */
export async function cloneRequest(apiKey: string, keyId: string, path: string, init: RequestInit = {}, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Response> {
  const identity = await resolveGatewayIdentity(apiKey, keyId)
  const headers = { ...gatewayIdentityHeaders(identity), ...(init.headers as Record<string, string> | undefined) }
  try {
    return await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new UpstreamError('upstream', 'Could not reach the voice cloning service. Try again shortly.', true)
  }
}

/** Maps an unsuccessful backend response onto the shared ErrorCode scheme, keeping the service's own code in detailCode. Always throws. */
export async function throwForClone(r: Response): Promise<never> {
  const body = (await r.json().catch(() => null)) as ErrBody | null
  const msg = typeof body?.error === 'string' ? body.error : undefined
  const detailCode = typeof body?.code === 'string' ? body.code : undefined
  const extra = { detailCode, details: body?.details }
  const s = r.status
  if (s === 401) throw new UpstreamError('unauthorized', 'Invalid or revoked API key, or the backend is not configured to trust this server for voice cloning yet.', false, extra)
  if (s === 402) throw new UpstreamError('payment_required', msg || 'Voice cloning requires an active paid plan with a payment method on file. Add one at https://readaloudai.org/developers#get-started.', false, extra)
  if (s === 403) throw new UpstreamError('forbidden', msg || 'This account cannot create cloned voices.', false, extra)
  if (s === 429) throw new UpstreamError('rate_limited', msg || 'Too many voice cloning requests. Wait and retry.', detailCode !== 'daily_limit', extra)
  if ([400, 404, 409, 410, 413, 422].includes(s)) throw new UpstreamError('invalid_input', msg || 'The voice cloning service rejected the request.', false, extra)
  if (s === 503 && detailCode === 'unavailable') throw new UpstreamError('upstream', msg || 'Voice cloning is not available right now.', false, extra)
  throw new UpstreamError('upstream', msg || `The voice cloning service returned ${s}.`, s >= 500, extra)
}

async function ok(r: Response): Promise<Response> {
  if (!r.ok) await throwForClone(r)
  return r
}

export interface ConsentPhraseResult {
  consent_required: boolean
  challenge_id?: string
  phrase?: string
  expires_at?: string
}

export async function issueConsentPhrase(o: { apiKey: string; keyId: string }): Promise<ConsentPhraseResult> {
  const r = await ok(await cloneRequest(o.apiKey, o.keyId, '/consent-phrase', { method: 'POST' }))
  const b = (await r.json().catch(() => null)) as Partial<ConsentPhraseResult> | null
  if (b?.consent_required === false) return { consent_required: false }
  if (!b?.challenge_id || !b.phrase || !b.expires_at) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return { consent_required: true, challenge_id: b.challenge_id, phrase: b.phrase, expires_at: b.expires_at }
}

export interface ClonedVoice { id: string; name: string; language: string; status: string; created_at?: string; reference_seconds?: number; model?: string }

export interface CreateCloneParts {
  name: string
  language: string
  challengeId?: string
  reference: AudioBlob
  consent?: AudioBlob
  attested?: boolean
}

export function buildCreateForm(p: CreateCloneParts): FormData {
  const fd = new FormData()
  if (p.challengeId) fd.append('challenge_id', p.challengeId)
  fd.append('name', p.name)
  fd.append('language', p.language.toLowerCase())
  if (p.consent) fd.append('consent', new Blob([new Uint8Array(p.consent.bytes)], { type: p.consent.mime }), p.consent.filename)
  fd.append('reference', new Blob([new Uint8Array(p.reference.bytes)], { type: p.reference.mime }), p.reference.filename)
  if (p.attested) fd.append('attested', 'true')
  return fd
}

/** Raw create call (the REST route relays the response as is; the MCP tool wraps it with createClonedVoice). */
export function createCloneRaw(o: { apiKey: string; keyId: string }, p: CreateCloneParts): Promise<Response> {
  return cloneRequest(o.apiKey, o.keyId, '/', { method: 'POST', body: buildCreateForm(p) }, HEAVY_TIMEOUT_MS)
}

export async function createClonedVoice(o: { apiKey: string; keyId: string }, p: CreateCloneParts): Promise<ClonedVoice> {
  const r = await ok(await createCloneRaw(o, p))
  const b = (await r.json().catch(() => null)) as ClonedVoice | null
  if (!b?.id) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return b
}

export async function listClonedVoices(o: { apiKey: string; keyId: string }): Promise<ClonedVoice[]> {
  const r = await ok(await cloneRequest(o.apiKey, o.keyId, '/'))
  const b = (await r.json().catch(() => null)) as { voices?: ClonedVoice[] } | null
  if (!b || !Array.isArray(b.voices)) throw new UpstreamError('upstream', 'Unexpected response from the voice cloning service.', true)
  return b.voices
}

export async function getCloneConfig(o: { apiKey: string; keyId: string }): Promise<{ consent_required: boolean }> {
  const r = await ok(await cloneRequest(o.apiKey, o.keyId, '/config'))
  const b = (await r.json().catch(() => null)) as { consent_required?: boolean } | null
  return { consent_required: b?.consent_required !== false }
}

export async function deleteClonedVoice(o: { apiKey: string; keyId: string; voiceId: string }): Promise<{ deleted: boolean; alreadyDeleted?: boolean }> {
  const r = await ok(await cloneRequest(o.apiKey, o.keyId, `/${encodeURIComponent(o.voiceId)}`, { method: 'DELETE' }))
  const b = (await r.json().catch(() => null)) as { deleted?: boolean; alreadyDeleted?: boolean } | null
  return { deleted: b?.deleted === true, alreadyDeleted: b?.alreadyDeleted }
}

export function speechRaw(o: { apiKey: string; keyId: string; voiceId: string; text: string; speed?: number }): Promise<Response> {
  return cloneRequest(o.apiKey, o.keyId, `/${encodeURIComponent(o.voiceId)}/speech`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: o.text, speed: o.speed ?? 1 }),
  }, HEAVY_TIMEOUT_MS)
}

export async function synthesizeClonedVoice(o: { apiKey: string; keyId: string; voiceId: string; text: string; speed?: number }): Promise<{ wav: Buffer; watermark: string | null; ms: number | null }> {
  const r = await ok(await speechRaw(o))
  const wav = Buffer.from(await r.arrayBuffer())
  if (wav.length === 0) throw new UpstreamError('upstream', 'The voice cloning service returned no audio.', true)
  const ms = Number(r.headers.get('x-synthesis-time-ms'))
  return { wav, watermark: r.headers.get('x-watermark'), ms: Number.isFinite(ms) && ms > 0 ? ms : null }
}
