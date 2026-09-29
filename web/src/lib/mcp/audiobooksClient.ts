// Client for this repo's backend Audiobooks MVP API (backend/src/routes/audiobooks.ts,
// mounted at /api/audiobooks behind requireAuth — see backend/src/index.ts).
//
// IMPORTANT / open item: the backend's audiobooks routes are Supabase-JWT
// authenticated, exactly like the rest of the backend API (routes/tts.ts
// etc). This MCP server's identity is a *developer API key* (`ctx.apiKey`),
// which is a different credential from a Supabase session — text_to_speech
// bridges that gap by exchanging the key for a session via the gateway's
// `/tts/authorize` (see upstream.ts), which lives in the separate
// realtime-tts-gateway repo.
//
// No equivalent "exchange an API key for backend identity" endpoint exists
// yet for audiobooks (that would be gateway-repo work, out of scope for the
// ReadAloudAI backend repo these tools were built in). Until that exists,
// these calls forward the raw API key as a bearer token, which only works
// if AUDIOBOOKS_BACKEND_URL is pointed at a backend/proxy that has been
// taught to accept it (e.g. via the same GATEWAY_FORWARD_SECRET + resolved
// x-gateway-uid pattern backend/src/routes/voiceStudioApiKey.ts already uses
// for the voice-cloning API front door). Wiring that resolution for
// audiobooks specifically is noted as a follow-up in the feature's report.

const BACKEND_URL = process.env.AUDIOBOOKS_BACKEND_URL || process.env.TTS_GATEWAY_URL || 'https://api.readaloudai.org'
const REQUEST_TIMEOUT_MS = 30_000

export class AudiobooksApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new AudiobooksApiError(0, 'Could not reach the audiobooks API. Try again shortly.')
  }

  const json = await r.json().catch(() => null) as Record<string, unknown> | null
  if (!r.ok) {
    const message = (json?.message as string | undefined) || (json?.error as string | undefined) || `Audiobooks API returned ${r.status}`
    throw new AudiobooksApiError(r.status, message)
  }
  return json as T
}

export interface AudiobookChapterStatus {
  sequence?: number
  sequence_index?: number
  title: string | null
  status: string
  duration_seconds?: number | null
  duration_sec?: number | null
  char_count?: number
}

export interface CreateAudiobookResult {
  audiobook_id: string
  status: string
  chapter_count: number
}

export interface AudiobookStatusResult {
  audiobook_id: string
  status: string
  chapter_count: number
  chapters_completed?: number
  chapters_ready?: number
  chapters_failed?: number
  overall_percentage?: number
  export_status?: string
  export_audio_path?: string | null
  chapters: AudiobookChapterStatus[]
  error?: { code?: string; message: string }
}

export interface ExportAudiobookResult {
  audiobook_id: string
  status?: string
  export_status?: string
  audio_url?: string
  duration_sec?: number
  duration_seconds?: number
}

export function createAudiobook(
  apiKey: string,
  params: { title: string; voice_id: string; speed?: number; text: string }
): Promise<CreateAudiobookResult> {
  return call(apiKey, 'POST', '/api/audiobooks', {
    title: params.title,
    voice_id: params.voice_id,
    speed: params.speed,
    source_type: 'text',
    text: params.text,
  })
}

export function getAudiobookStatus(apiKey: string, audiobookId: string): Promise<AudiobookStatusResult> {
  return call(apiKey, 'GET', `/api/audiobooks/${encodeURIComponent(audiobookId)}/status`)
}

export function exportAudiobook(apiKey: string, audiobookId: string): Promise<ExportAudiobookResult> {
  return call(apiKey, 'POST', `/api/audiobooks/${encodeURIComponent(audiobookId)}/export`)
}
