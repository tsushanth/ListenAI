import { API_BASE_URL, authHeaders, fail } from './toolsApiCommon'

// Backend: POST /api/sound-effects/job {prompt (1-500 chars), duration_sec (1-12)} -> 202
//   {job_id, status: 'ready'|'processing', cache_hit, audio_url?, estimated_wait_sec}
//          GET /api/sound-effects/job/:jobId -> {status: queued|processing|ready|failed, audio_url?, error?: {code, message}}

export const SFX_MIN_SEC = 1
export const SFX_MAX_SEC = 12
export const SFX_MAX_PROMPT = 500

export interface SoundEffectJob {
  job_id: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  cache_hit: boolean
  audio_url?: string
  estimated_wait_sec: number
}

export interface SoundEffectStatus {
  job_id: string
  status: 'queued' | 'processing' | 'ready' | 'failed'
  audio_url?: string
  error?: { code: string; message: string }
}

export const soundEffectsApi = {
  async create(params: { prompt: string; durationSec: number }): Promise<SoundEffectJob> {
    const res = await fetch(`${API_BASE_URL}/api/sound-effects/job`, {
      method: 'POST',
      headers: await authHeaders(true),
      body: JSON.stringify({ prompt: params.prompt, duration_sec: params.durationSec }),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async get(jobId: string): Promise<SoundEffectStatus> {
    const res = await fetch(`${API_BASE_URL}/api/sound-effects/job/${encodeURIComponent(jobId)}`, {
      headers: await authHeaders(),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },
}
