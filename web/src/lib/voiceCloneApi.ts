import { API_BASE_URL, token } from './toolsApiCommon'
import { mapCloneError, extensionForMime, selectCloneFlow, type CloneErrorBody, type CloneFlow, type MappedError } from './voiceCloneErrors'

/** Thrown for every failed call; carries the mapped, user-facing error. */
export class CloneApiError extends Error {
  status: number
  mapped: MappedError
  constructor(status: number, mapped: MappedError) {
    super(mapped.message)
    this.name = 'CloneApiError'
    this.status = status
    this.mapped = mapped
  }
}

export interface ConsentChallenge { challenge_id: string; phrase: string; expires_at: string }
export interface ClonedVoice { id: string; name: string; language: string; status: string; created_at: string; reference_seconds?: number }

async function send(path: string, init: RequestInit = {}): Promise<Response> {
  let bearer: string
  try { bearer = await token() } catch {
    throw new CloneApiError(401, mapCloneError(401, null))
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${bearer}` } })
  } catch {
    throw new CloneApiError(0, mapCloneError(0, null))
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as CloneErrorBody | null
    throw new CloneApiError(res.status, mapCloneError(res.status, body))
  }
  return res
}

export const voiceCloneApi = {
  async challenge(): Promise<ConsentChallenge> {
    return (await send('/api/voice-clones/consent-challenges', { method: 'POST' })).json()
  },

  /** Which flow to run. Never throws: any failure (network, 404, bad body) yields the strict flow, the safe default. */
  async flow(): Promise<CloneFlow> {
    try { return selectCloneFlow(await (await send('/api/voice-clones/config')).json()) } catch { return 'strict' }
  },

  /** Attestation mode: no challenge and no consent clip; the server records that the user attested. */
  async createAttested(i: { name: string; language: string; reference: Blob | File }): Promise<ClonedVoice> {
    const fd = new FormData()
    fd.append('name', i.name)
    fd.append('language', i.language)
    fd.append('reference', i.reference, (i.reference as File).name || `reference.${extensionForMime(i.reference.type)}`)
    fd.append('attested', 'true')
    return (await send('/api/voice-clones', { method: 'POST', body: fd })).json()
  },

  async create(i: { challengeId: string; name: string; language: string; consent: Blob; reference: Blob | File }): Promise<ClonedVoice> {
    const fd = new FormData()
    fd.append('challenge_id', i.challengeId)
    fd.append('name', i.name)
    fd.append('language', i.language)
    // Field order matters to nothing server-side, but the file parts need a filename so multer sees them as files.
    fd.append('consent', i.consent, `consent.${extensionForMime(i.consent.type)}`)
    fd.append('reference', i.reference, (i.reference as File).name || `reference.${extensionForMime(i.reference.type)}`)
    return (await send('/api/voice-clones', { method: 'POST', body: fd })).json()
  },

  async list(): Promise<ClonedVoice[]> {
    const r = (await (await send('/api/voice-clones')).json()) as { voices: ClonedVoice[] }
    return r.voices
  },

  async remove(id: string): Promise<void> {
    await send(`/api/voice-clones/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  /** Synchronous synthesis (<= 1500 chars). Returns a blob: URL for the WAV. Cold start can take up to ~3 minutes. */
  async synthesize(i: { text: string; voiceId: string; speed: number }, signal?: AbortSignal): Promise<{ url: string; bytes: number }> {
    const res = await send('/api/tts/cloned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: i.text, voice_id: i.voiceId, speed: i.speed }),
      signal,
    })
    const blob = await res.blob()
    return { url: URL.createObjectURL(blob), bytes: blob.size }
  },
}
