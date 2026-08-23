// Client for the backend's /api/tts-api-keys routes. Separate from api.ts's
// device-ID-based apiRequest() helper because this needs a real Supabase session
// Bearer token, not X-Device-ID — see backend/src/routes/ttsApiKeys.ts.
import { supabase } from './supabaseClient'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

export interface TTSApiKeySummary {
  id: string
  label: string | null
  key_preview: string
  created_at: string
  revoked: boolean
}

async function authedRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Not signed in.')

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export const ttsApiKeysApi = {
  list: () => authedRequest<{ keys: TTSApiKeySummary[] }>('/api/tts-api-keys'),

  create: (label?: string) =>
    authedRequest<{ id: string; key: string; key_preview: string; label: string | null; created_at: string }>(
      '/api/tts-api-keys',
      { method: 'POST', body: JSON.stringify({ label }) }
    ),

  revoke: (id: string) => authedRequest<{ revoked: boolean }>(`/api/tts-api-keys/${id}`, { method: 'DELETE' }),
}
