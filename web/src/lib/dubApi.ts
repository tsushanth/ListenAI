import { API_BASE_URL, authHeaders, fail } from './toolsApiCommon'
import { normalizeAudioFile } from './audioFiles'

// Backend: POST /api/dub (multipart: audio, target_language, source_language?, voice_id?) -> 202 {job_id, status}
//          GET  /api/dub/:jobId -> {status: processing|ready|failed, audio_url?, segments?, error?}
// Jobs are held in server memory (1 hour TTL), so a 404 while polling means the job was lost.

export type DubStatus = 'processing' | 'ready' | 'failed'

export interface DubSegment {
  index: number
  source_text: string
  translated_text: string
  start_sec: number
  end_sec: number
  speed_used: number
}

export interface DubJob {
  job_id: string
  status: DubStatus
}

export interface DubResult extends DubJob {
  target_language: string
  source_language: string | null
  audio_url?: string
  segments?: DubSegment[]
  error?: string
}

export const dubApi = {
  async create(params: { audio: File; targetLanguage: string; sourceLanguage?: string }): Promise<DubJob> {
    const form = new FormData()
    form.append('audio', normalizeAudioFile(params.audio))
    form.append('target_language', params.targetLanguage)
    if (params.sourceLanguage) form.append('source_language', params.sourceLanguage)

    const res = await fetch(`${API_BASE_URL}/api/dub`, {
      method: 'POST',
      headers: await authHeaders(),
      body: form,
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async get(jobId: string): Promise<DubResult> {
    const res = await fetch(`${API_BASE_URL}/api/dub/${encodeURIComponent(jobId)}`, {
      headers: await authHeaders(),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },
}
