import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export interface VoiceDesignPreset {
  id: string
  name: string
  description: string
  created_at: string
}

export interface VoiceDesignJob {
  job_id: string
  status: 'queued' | 'running' | 'ready' | 'failed'
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
  const res = await fetch(`${API_BASE_URL}/api/voice-design${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${await token()}`, ...init.headers },
  })
  if (!res.ok) return fail(res)
  return res.json()
}

async function audio(path: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/voice-design${path}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  })
  if (!res.ok) return fail(res)
  return URL.createObjectURL(await res.blob())
}

export const voiceDesignApi = {
  async presets(): Promise<VoiceDesignPreset[]> {
    return request<{ presets: VoiceDesignPreset[] }>('/presets').then((r) => r.presets)
  },
  savePreset: (b: { name: string; description: string }) =>
    request<VoiceDesignPreset>('/presets', { method: 'POST', body: JSON.stringify(b) }),
  deletePreset: (id: string) =>
    request<{ deleted: boolean }>(`/presets/${id}`, { method: 'DELETE' }),
  create: (b: { description: string; text: string }) =>
    request<VoiceDesignJob>('/designs', { method: 'POST', body: JSON.stringify(b) }),
  poll: (jobId: string) =>
    request<{ status: string; ready_at?: string; timings?: Record<string, number> }>(`/designs/${jobId}`),
  audio: (jobId: string) => audio(`/designs/${jobId}/audio`),
}
