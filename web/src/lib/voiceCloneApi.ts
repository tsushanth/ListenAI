import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export interface ClonedVoice {
  id: string
  modal_voice_id: string
  name: string
  language: string
  reference_seconds: number | null
  status: string
  created_at: string
}

export interface CreateVoiceResult {
  id: string
  modal_voice_id: string
  name: string
  language: string
  reference_seconds: number | null
  status: string
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
  const res = await fetch(`${API_BASE_URL}/api/voice-clone${path}`, {
    ...init,
    headers: { ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${await token()}`, ...init.headers },
  })
  if (!res.ok) return fail(res)
  return res.json()
}

async function audio(path: string): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/api/voice-clone${path}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  })
  if (!res.ok) return fail(res)
  return URL.createObjectURL(await res.blob())
}

export const voiceCloneApi = {
  async list(): Promise<ClonedVoice[]> {
    return request<{ voices: ClonedVoice[] }>('/').then((r) => r.voices)
  },

  async create(params: {
    name: string
    language: string
    audioFile: File
  }): Promise<CreateVoiceResult> {
    const form = new FormData()
    form.append('name', params.name)
    form.append('language', params.language)
    form.append('reference', params.audioFile)
    form.append(
      'consent_statement',
      'I confirm that I have the legal right to clone this voice and agree to the Terms of Use. I will not use this feature to impersonate any person without their consent.'
    )
    return request<CreateVoiceResult>('/', { method: 'POST', body: form })
  },

  async synthesize(voiceId: string, text: string, language?: string): Promise<string> {
    const res = await fetch(`${API_BASE_URL}/api/voice-clone/${voiceId}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ text, language }),
    })
    if (!res.ok) return fail(res)
    return URL.createObjectURL(await res.blob())
  },

  async delete(voiceId: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>(`/${voiceId}`, { method: 'DELETE' })
  },

  async referenceAudio(voiceId: string): Promise<string> {
    return audio(`/${voiceId}/reference`)
  },
}
