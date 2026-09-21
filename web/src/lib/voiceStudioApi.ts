// Client for the backend's /api/voice-studio routes (see backend/src/routes/voiceStudioRouter.ts).
// Needs a real Supabase session bearer token, like ttsApiKeysApi.ts. A test-only mock session exists for
// screenshots against a local mock server: it needs NEXT_PUBLIC_VOICE_STUDIO_MOCK=1 at BUILD time (which
// next.config.js refuses unless RA_ALLOW_MOCK_BUILD=1) AND a localhost origin at run time.
import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export function isMockMode(): boolean {
  if (process.env.NEXT_PUBLIC_VOICE_STUDIO_MOCK !== '1') return false
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
}

export interface VoiceWarning { code: string; message: string }
export interface StudioVoice {
  id: string
  status: 'created' | 'training' | 'ready' | 'rejected' | 'deployed'
  speaker_name: string | null
  created_at: number | null
  warnings: Array<VoiceWarning | string>
  stats?: { minutes?: number; clips?: number }
  error?: { code: string; reason: string }
  voice?: string
}
export interface StudioConfig { enabled: true; consent_text_version: string; max_zip_bytes: number; part_bytes: number }

async function token(): Promise<string> {
  if (isMockMode()) return 'mock-token'
  const { data } = await supabase.auth.getSession()
  const t = data.session?.access_token
  if (!t) throw new Error('Please sign in again.')
  return t
}

async function fail(res: Response): Promise<never> {
  const err = await res.json().catch(() => ({ error: '' }))
  throw new Error(err.error || `Something went wrong (HTTP ${res.status}).`)
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api/voice-studio${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${await token()}`, ...init.headers },
  })
  if (!res.ok) return fail(res)
  return res.json()
}

async function audio(path: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/voice-studio${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${await token()}` },
  })
  if (!res.ok) return fail(res)
  return URL.createObjectURL(await res.blob())
}

/** One part upload with progress; resolves when the server has stored it. */
async function putPart(id: string, n: number, blob: Blob, onProgress: (loaded: number) => void): Promise<void> {
  const t = await token()
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${API_BASE_URL}/api/voice-studio/${id}/dataset/parts/${n}`)
    xhr.setRequestHeader('Authorization', `Bearer ${t}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let msg = `Upload failed (HTTP ${xhr.status}).`
      try { msg = JSON.parse(xhr.responseText).error || msg } catch { /* keep default */ }
      const e = new Error(msg) as Error & { status?: number }
      e.status = xhr.status
      reject(e)
    }
    xhr.onerror = () => reject(new Error('The connection dropped.'))
    xhr.send(blob)
  })
}

export const voiceStudioApi = {
  /** null when the feature is off for this user (404) or on any error - the UI then simply hides it. */
  async config(): Promise<StudioConfig | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/voice-studio/enabled`, { headers: { Authorization: `Bearer ${await token()}` } })
      return res.ok ? await res.json() : null
    } catch { return null }
  },
  list: () => request<{ voices: StudioVoice[] }>('/').then((r) => r.voices),
  get: (id: string) => request<StudioVoice>(`/${id}`),
  create: (b: { speaker_name: string; attested_by: string; consent_text_version: string }) =>
    request<{ id: string }>('/', { method: 'POST', body: JSON.stringify({ ...b, consent: true }) }),
  listParts: (id: string) => request<{ parts: Array<{ part: number; bytes: number }> }>(`/${id}/dataset/parts`),
  putPart,
  commit: (id: string, parts: number) => request<{ id: string; status: string }>(`/${id}/dataset/commit`, { method: 'POST', body: JSON.stringify({ parts }) }),
  sample: (id: string, n: number) => audio(`/${id}/samples/${n}`),
  preview: (id: string, text: string) => audio(`/${id}/preview`, { method: 'POST', body: JSON.stringify({ text }) }),
  deploy: (id: string) => request<{ id: string; voice: string }>(`/${id}/deploy`, { method: 'POST' }),
  remove: (id: string) => request<{ deleted: boolean }>(`/${id}`, { method: 'DELETE' }),
}
