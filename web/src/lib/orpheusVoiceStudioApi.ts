// Client for the backend's /api/orpheus-voice-studio routes (see
// backend/src/routes/orpheusVoiceStudio.ts), the web-session-authenticated front door for Orpheus
// streaming voice cloning. Mirrors voiceStudioApi.ts's shape (Supabase bearer token, fetch wrapper) but
// hits the Orpheus router instead, whose 6 operations (create/upload/commit/status/delete/synthesize)
// mirror the API-key gateway route (routes/orpheusVoiceStudioApiKey.ts) one-for-one — there is no chunked
// part upload, deploy or fixed sample-sentence step like the ReadAloud Live flow has, since Orpheus's Modal service
// doesn't expose those.
import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export type OrpheusVoiceStatus = 'awaiting_dataset' | 'training' | 'warming' | 'ready' | 'failed' | string

export interface OrpheusVoice {
  id: string
  status: OrpheusVoiceStatus
  speaker_name?: string | null
  created_at?: number | string | null
  error?: { code?: string; reason?: string } | string | null
  [key: string]: unknown
}

async function token(): Promise<string> {
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
  const res = await fetch(`${API_BASE_URL}/api/orpheus-voice-studio${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${await token()}`, ...init.headers },
  })
  if (!res.ok) return fail(res)
  return res.json()
}

/** Synthesize (POST /tts) returns audio bytes, not JSON. */
async function synthesizeAudio(body: { voice: string; text: string; [k: string]: unknown }): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/orpheus-voice-studio/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) return fail(res)
  return URL.createObjectURL(await res.blob())
}

export const orpheusVoiceStudioApi = {
  create: (b: { speaker_name: string; [k: string]: unknown }) =>
    request<OrpheusVoice & { id: string }>('/', { method: 'POST', body: JSON.stringify(b) }),
  uploadDataset: async (id: string, zip: Blob): Promise<void> => {
    const res = await fetch(`${API_BASE_URL}/api/orpheus-voice-studio/${id}/dataset`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', Authorization: `Bearer ${await token()}` },
      body: zip,
    })
    if (!res.ok) return fail(res)
  },
  commit: (id: string) => request<{ id: string; status: string }>(`/${id}/dataset/commit`, { method: 'POST', body: JSON.stringify({}) }),
  status: (id: string) => request<OrpheusVoice>(`/${id}`),
  remove: (id: string) => request<{ deleted?: boolean }>(`/${id}`, { method: 'DELETE' }),
  synthesize: (voice: string, text: string) => synthesizeAudio({ voice, text }),
}
