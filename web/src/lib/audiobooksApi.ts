import { API_BASE_URL, authHeaders, fail } from './toolsApiCommon'

// Backend: /api/audiobooks
//   POST /            JSON {title, voice_id, speed?, source_type: 'text'|'epub', text | epub_base64} -> 202
//   GET  /:id/status  aggregate + per-chapter status
//   POST /:id/export  concatenate chapters into one MP3 -> {audio_url, duration_seconds}
// The whole JSON body must fit the server's 1 MB express.json() limit, which caps text at
// roughly 1M characters and EPUBs at roughly 730 KB (base64 inflates by 4/3).

/** express.json({ limit: '1mb' }) in backend/src/index.ts; keep a little headroom. */
export const MAX_BODY_BYTES = 1_000_000
export const MAX_EPUB_BYTES = 700 * 1024
export const MIN_SPEED = 0.5
export const MAX_SPEED = 3.0
export const MAX_TITLE = 500

export type AudiobookStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type ChapterStatus = 'pending' | 'queued' | 'processing' | 'ready' | 'failed' | 'canceled'

export interface CreatedAudiobook {
  audiobook_id: string
  status: AudiobookStatus
  chapter_count: number
  chapters: Array<{ id: string; sequence: number; title: string | null; char_count: number }>
}

export interface ChapterProgress {
  id: string
  sequence: number
  title: string | null
  status: ChapterStatus
  percentage: number
  duration_seconds: number | null
  error_message: string | null
}

export interface AudiobookProgress {
  audiobook_id: string
  status: AudiobookStatus
  chapter_count: number
  chapters_completed: number
  overall_percentage: number
  export_status: 'not_started' | 'processing' | 'completed' | 'failed'
  chapters: ChapterProgress[]
}

export interface AudiobookExport {
  audiobook_id: string
  export_status: 'completed'
  audio_url: string | null
  duration_seconds: number
}

export interface VoiceOption {
  id: string
  name: string
  hint?: string
  is_premium?: boolean
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onerror = () => reject(new Error('Could not read the EPUB file.'))
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.readAsDataURL(file)
  })
}

export const audiobooksApi = {
  /** Public endpoint, no auth needed. */
  async listVoices(): Promise<VoiceOption[]> {
    const res = await fetch(`${API_BASE_URL}/api/voices`)
    if (!res.ok) return fail(res)
    const body = (await res.json()) as { voices?: VoiceOption[] }
    return body.voices ?? []
  },

  async create(params: {
    title: string
    voiceId: string
    speed: number
    source: { type: 'text'; text: string } | { type: 'epub'; file: File }
  }): Promise<CreatedAudiobook> {
    const payload: Record<string, unknown> = {
      title: params.title,
      voice_id: params.voiceId,
      speed: params.speed,
      source_type: params.source.type,
    }
    if (params.source.type === 'text') payload.text = params.source.text
    else payload.epub_base64 = await fileToBase64(params.source.file)

    const body = JSON.stringify(payload)
    if (new Blob([body]).size > MAX_BODY_BYTES) {
      throw new Error('This book is too large to submit from the browser (limit is about 1 MB of request data). Split it into parts.')
    }

    const res = await fetch(`${API_BASE_URL}/api/audiobooks`, {
      method: 'POST',
      headers: await authHeaders(true),
      body,
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async status(id: string): Promise<AudiobookProgress> {
    const res = await fetch(`${API_BASE_URL}/api/audiobooks/${encodeURIComponent(id)}/status`, {
      headers: await authHeaders(),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },

  async export(id: string): Promise<AudiobookExport> {
    const res = await fetch(`${API_BASE_URL}/api/audiobooks/${encodeURIComponent(id)}/export`, {
      method: 'POST',
      headers: await authHeaders(true),
    })
    if (!res.ok) return fail(res)
    return res.json()
  },
}
