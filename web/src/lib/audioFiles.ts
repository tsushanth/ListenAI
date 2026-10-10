// Client-side audio file validation. Limits mirror the backend routes:
//   stt.ts          200 MB, WAV FLAC OGG MP3 M4A WEBM, min 64 bytes
//   dub.ts           50 MB, WAV FLAC OGG MP3 M4A WEBM, min 1 KB
// The backends check the multipart part's Content-Type strictly, and browsers report
// odd types for common files (audio/x-wav, audio/wave, '' for .flac), so files are
// re-labelled from their extension before upload (see normalizeAudioFile).

const EXT_MIME: Record<string, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
}

export interface AudioRules {
  maxMb: number
  minBytes: number
  /** Allowed extensions, lower case, no dot. */
  exts: readonly string[]
  /** Label for messages, e.g. "WAV, FLAC, OGG, MP3, M4A". */
  label: string
}

export const AUDIO_RULES = {
  stt: { maxMb: 200, minBytes: 64, exts: ['wav', 'flac', 'ogg', 'mp3', 'm4a', 'webm'], label: 'WAV, FLAC, OGG, MP3, M4A, WEBM' },
  dub: { maxMb: 50, minBytes: 1024, exts: ['wav', 'flac', 'ogg', 'mp3', 'm4a', 'webm'], label: 'WAV, FLAC, OGG, MP3, M4A, WEBM' },
} as const satisfies Record<string, AudioRules>

export function acceptAttr(rules: AudioRules): string {
  return rules.exts.map((e) => `.${e}`).join(',')
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Returns an error message, or null when the file passes. */
export function validateAudio(file: File, rules: AudioRules, what = 'Audio file'): string | null {
  const ext = extOf(file.name)
  if (!rules.exts.includes(ext)) return `${what} type not supported: ${file.name}. Use ${rules.label}.`
  if (file.size < rules.minBytes) return `${what} is too small or empty: ${file.name}.`
  if (file.size > rules.maxMb * 1024 * 1024) {
    return `${what} too large: ${fmtSize(file.size)} (max ${rules.maxMb} MB).`
  }
  return null
}

/** Re-label the file with the MIME type the backend allow-list expects. */
export function normalizeAudioFile(file: File): File {
  const mime = EXT_MIME[extOf(file.name)]
  if (!mime || file.type === mime) return file
  return new File([file], file.name, { type: mime, lastModified: file.lastModified })
}
