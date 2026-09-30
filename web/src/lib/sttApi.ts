import { API_BASE_URL, authHeaders, fail } from './toolsApiCommon'
import { normalizeAudioFile } from './audioFiles'

// Backend: POST /api/stt/transcriptions (multipart: audio, language?, word_timestamps?).
// Synchronous: the request blocks until the transcript is ready (can take minutes for long audio).

export interface SttWord {
  word: string
  start: number
  end: number
}

export interface SttSegment {
  id: number
  start: number
  end: number
  text: string
}

export interface Transcription {
  id: string
  status: 'done'
  text: string
  language: string
  language_probability: number | null
  duration: number
  words?: SttWord[]
  segments?: SttSegment[]
}

export const sttApi = {
  async transcribe(params: { audio: File; language?: string; wordTimestamps: boolean }): Promise<Transcription> {
    const form = new FormData()
    form.append('audio', normalizeAudioFile(params.audio))
    if (params.language) form.append('language', params.language)
    if (params.wordTimestamps) form.append('word_timestamps', 'true')

    const res = await fetch(`${API_BASE_URL}/api/stt/transcriptions`, {
      method: 'POST',
      headers: await authHeaders(),
      body: form,
    })
    if (!res.ok) return fail(res)
    return res.json()
  },
}

// ---------------------------------------------------------------------------
// Subtitle / text formatting (pure functions, no network)
// ---------------------------------------------------------------------------

export interface Cue {
  start: number
  end: number
  text: string
}

/** Build subtitle cues from segments if present, else by grouping words. Empty when no timing exists. */
export function buildCues(t: Pick<Transcription, 'segments' | 'words'>): Cue[] {
  if (t.segments && t.segments.length > 0) {
    return t.segments
      .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
      .filter((c) => c.text.length > 0)
  }
  if (t.words && t.words.length > 0) {
    const cues: Cue[] = []
    let cur: SttWord[] = []
    const flush = () => {
      if (cur.length === 0) return
      cues.push({
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        text: cur.map((w) => w.word.trim()).join(' '),
      })
      cur = []
    }
    for (const w of t.words) {
      cur.push(w)
      const span = w.end - cur[0].start
      if (cur.length >= 10 || span >= 5 || /[.!?]$/.test(w.word.trim())) flush()
    }
    flush()
    return cues
  }
  return []
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n')
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}\n`).join('\n')}`
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
