// Public REST API for consent-gated voice cloning: https://readaloudai.org/api/v1/voice-clones/*
//
//   POST   /consent-phrase     step 1: issue the phrase the speaker must read aloud
//   POST   /                   step 2: create the clone (multipart, or JSON with base64 / https URL audio)
//   GET    /                   list your cloned voices
//   GET    /config             { consent_required }
//   DELETE /{id}               delete a cloned voice (reference audio and embeddings)
//   POST   /{id}/speech        step 3: { text, speed? } -> audio/wav, only for the voice's owner
//
// Auth: `Authorization: Bearer <API key>`, the same key as the rest of the Voice API, and the key must belong to a
// ReadAloud account. The key is validated against the gateway and only the resolved account is forwarded to the
// backend (see cloneClient.ts / upstream.ts); it is never logged or stored, and audio is never logged. All consent,
// plan, daily-limit and abuse rules are enforced by the backend, so a response here is the backend's response.
import { createHash } from 'node:crypto'
import { SlidingWindowLimiter } from './ratelimit.ts'
import { UpstreamError } from './upstream.ts'
import {
  AUDIO_MIME_TYPES, CLONE_MAX_AUDIO_MB, CLONE_VOICE_ID_RE, cloneCreateLimiter, cloneRequest, cloneSpeechLimiter, createCloneRaw,
  createClonedVoiceSchema, makeAudio, resolveAudioInput, sniffAudioMime, speechRaw, type AudioBlob,
} from './cloneClient.ts'

const ipLimiter = new SlidingWindowLimiter(120, 60_000)
const readLimiter = new SlidingWindowLimiter(30, 60_000)
const MAX_BODY_BYTES = 60 * 1024 * 1024
const SPEECH_MAX_CHARS = 1500

export type VoiceCloneOp = 'config' | 'phrase' | 'list' | 'create' | 'delete' | 'speech'

function jsonError(status: number, code: string, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return Response.json({ error, code, ...extra }, { status, headers: { 'Cache-Control': 'no-store', ...headers } })
}

function fromUpstream(e: UpstreamError): Response {
  const code = e.detailCode ?? e.code
  const extra = e.details ? { details: e.details } : {}
  switch (e.code) {
    case 'unauthorized': return jsonError(401, 'unauthenticated', e.message)
    case 'payment_required': return jsonError(402, 'payment_required', e.message, extra)
    case 'forbidden': return jsonError(403, code, e.message, extra)
    case 'rate_limited': return jsonError(429, code === 'daily_limit' ? code : 'rate_limited', e.message, extra, { 'Retry-After': '60' })
    // Backend answers are relayed untouched; only our own input checks (bad audio, unsafe URL) end up here.
    case 'invalid_input': return jsonError(400, 'validation', e.message)
    default: return jsonError(e.retryable ? 503 : 502, code === 'upstream' ? (e.retryable ? 'service_unavailable' : 'unavailable') : code, e.message, extra)
  }
}

/** Relays a backend response (status, JSON or audio body, and the few headers that matter) without re-interpreting it. */
async function relay(r: Response): Promise<Response> {
  if (r.status === 401) return jsonError(401, 'unauthenticated', 'Invalid or revoked API key, or this server is not trusted by the backend for voice cloning yet.')
  const h = new Headers({ 'Cache-Control': 'no-store' })
  for (const k of ['content-type', 'x-voice-id', 'x-model', 'x-watermark', 'x-characters-used', 'x-synthesis-time-ms', 'retry-after']) {
    const v = r.headers.get(k)
    if (v) h.set(k, v)
  }
  return new Response(await r.arrayBuffer(), { status: r.status, headers: h })
}

function mimeFor(file: File): string | undefined {
  const t = file.type.split(';')[0].trim().toLowerCase()
  return (AUDIO_MIME_TYPES as readonly string[]).includes(t) ? t : undefined
}

async function audioFromFile(v: FormDataEntryValue | null, label: string): Promise<AudioBlob | null> {
  if (!v || typeof v === 'string') return null
  const bytes = Buffer.from(await v.arrayBuffer())
  return makeAudio(bytes, label, mimeFor(v) ?? sniffAudioMime(bytes) ?? undefined)
}

async function parseCreate(req: Request): Promise<{ name: string; language: string; challengeId?: string; reference: AudioBlob; consent?: AudioBlob; attested?: boolean } | Response> {
  const len = Number(req.headers.get('content-length') || 0)
  if (len > MAX_BODY_BYTES) return jsonError(413, 'upload_error', `Request body is larger than ${MAX_BODY_BYTES / 1048576} MB. Use https URLs for large recordings.`)
  const ct = (req.headers.get('content-type') || '').toLowerCase()
  if (ct.startsWith('multipart/form-data')) {
    const fd = await req.formData().catch(() => null)
    if (!fd) return jsonError(400, 'validation', 'Could not read the multipart body.')
    const f = createClonedVoiceSchema.pick({ name: true, language: true, challenge_id: true }).safeParse({
      name: fd.get('name') ?? undefined, language: fd.get('language') ?? undefined, challenge_id: fd.get('challenge_id') ?? undefined,
    })
    if (!f.success) return jsonError(400, 'validation', 'Invalid request.', { details: f.error.flatten().fieldErrors })
    const reference = await audioFromFile(fd.get('reference'), 'reference')
    if (!reference) return jsonError(400, 'audio_required', 'A reference recording (multipart file field "reference") is required.')
    return { name: f.data.name, language: f.data.language, challengeId: f.data.challenge_id, reference, consent: (await audioFromFile(fd.get('consent'), 'consent')) ?? undefined, attested: fd.get('attested') === 'true' }
  }
  if (ct.startsWith('application/json')) {
    const raw = await req.json().catch(() => null)
    const p = createClonedVoiceSchema.safeParse(raw)
    if (!p.success) return jsonError(400, 'validation', 'Invalid request.', { details: p.error.flatten().fieldErrors })
    const d = p.data
    const reference = await resolveAudioInput({ label: 'reference', base64: d.reference_audio_base64, url: d.reference_audio_url, mime: d.reference_mime_type, maxBase64Mb: CLONE_MAX_AUDIO_MB })
    if (!reference) return jsonError(400, 'audio_required', 'Provide reference_audio_base64 or reference_audio_url.')
    const consent = await resolveAudioInput({ label: 'consent', base64: d.consent_audio_base64, url: d.consent_audio_url, mime: d.consent_mime_type, maxBase64Mb: CLONE_MAX_AUDIO_MB })
    return { name: d.name, language: d.language, challengeId: d.challenge_id, reference, consent: consent ?? undefined, attested: d.attested }
  }
  return jsonError(415, 'validation', 'Send multipart/form-data or application/json.')
}

export async function handleVoiceCloneRest(req: Request, route: { op: VoiceCloneOp; id?: string }): Promise<Response> {
  const ip = req.headers.get('fly-client-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown'
  const ipRl = ipLimiter.check(ip)
  if (!ipRl.ok) return jsonError(429, 'rate_limited', 'Too many requests from this IP. Slow down.', {}, { 'Retry-After': String(ipRl.retryAfterSec) })

  const m = /^Bearer\s+(\S{8,256})$/i.exec(req.headers.get('authorization') || '')
  if (!m) return jsonError(401, 'unauthenticated', 'Send "Authorization: Bearer <your ReadAloud AI API key>". Get a key at https://readaloudai.org/developers#get-started')
  const apiKey = m[1]
  const keyId = createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
  const o = { apiKey, keyId }

  const limiter = route.op === 'speech' ? cloneSpeechLimiter : route.op === 'list' || route.op === 'config' ? readLimiter : cloneCreateLimiter
  const rl = limiter.check(keyId)
  if (!rl.ok) return jsonError(429, 'rate_limited', `Too many requests for this key. Try again in ${rl.retryAfterSec} s.`, {}, { 'Retry-After': String(rl.retryAfterSec) })

  if ((route.op === 'delete' || route.op === 'speech') && !(route.id && CLONE_VOICE_ID_RE.test(route.id))) {
    return jsonError(400, 'validation', 'Invalid voice id.')
  }
  const id = route.id?.toLowerCase()

  try {
    switch (route.op) {
      case 'config': return relay(await cloneRequest(apiKey, keyId, '/config'))
      case 'phrase': return relay(await cloneRequest(apiKey, keyId, '/consent-phrase', { method: 'POST' }))
      case 'list': return relay(await cloneRequest(apiKey, keyId, '/'))
      case 'delete': return relay(await cloneRequest(apiKey, keyId, `/${encodeURIComponent(id!)}`, { method: 'DELETE' }))
      case 'create': {
        const parsed = await parseCreate(req)
        if (parsed instanceof Response) return parsed
        return relay(await createCloneRaw(o, parsed))
      }
      case 'speech': {
        const body = (await req.json().catch(() => null)) as { text?: unknown; speed?: unknown } | null
        const text = typeof body?.text === 'string' ? body.text : ''
        const speed = body?.speed === undefined ? 1 : Number(body.speed)
        if (!text || text.length > SPEECH_MAX_CHARS || !Number.isFinite(speed) || speed < 0.5 || speed > 3) {
          return jsonError(400, 'validation', `Send JSON { "text": 1-${SPEECH_MAX_CHARS} characters, "speed": 0.5-3 (optional) }.`)
        }
        return relay(await speechRaw({ ...o, voiceId: id!, text, speed }))
      }
    }
  } catch (e) {
    if (e instanceof UpstreamError) return fromUpstream(e)
    return jsonError(500, 'internal', 'Something went wrong.')
  }
}
