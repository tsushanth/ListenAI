// Pure helpers for the consent-gated voice cloning page: limits, duration checks, countdown formatting and the
// mapping from backend error codes to user-facing messages and a recovery action. No imports on purpose, so
// node --test can load it. Contract: docs/VOICE_CLONING_CONSENT.md.

export const LIMITS = {
  referenceMinSec: 8,
  referenceMaxSec: 120,
  consentMinSec: 3,
  consentMaxSec: 40,
  maxUploadBytes: 25 * 1024 * 1024,
  maxTextChars: 1500,
  speedMin: 0.5,
  speedMax: 3,
} as const

/** Chatterbox Multilingual languages accepted by the backend (service.ts SUPPORTED_LANGUAGES). */
export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' }, { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' }, { code: 'pl', label: 'Polish' }, { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' }, { code: 'ar', label: 'Arabic' }, { code: 'he', label: 'Hebrew' },
  { code: 'hi', label: 'Hindi' }, { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' }, { code: 'da', label: 'Danish' }, { code: 'el', label: 'Greek' },
  { code: 'fi', label: 'Finnish' }, { code: 'ms', label: 'Malay' }, { code: 'no', label: 'Norwegian' },
  { code: 'sv', label: 'Swedish' }, { code: 'sw', label: 'Swahili' },
]

export const SAMPLE_SENTENCES: Record<'en' | 'es', string> = {
  en: 'Hello, this is my cloned voice. The quick brown fox jumps over the lazy dog, and then walks quietly home.',
  es: 'Hola, esta es mi voz clonada. El veloz zorro marrón salta sobre el perro perezoso y luego camina a casa en silencio.',
}

export type DurationCheck = { ok: true } | { ok: false; reason: 'short' | 'long'; message: string }

export function checkDuration(sec: number, min: number, max: number, what: string): DurationCheck {
  if (sec < min) return { ok: false, reason: 'short', message: `The ${what} is ${sec.toFixed(1)} s. It must be at least ${min} s.` }
  if (sec > max) return { ok: false, reason: 'long', message: `The ${what} is ${sec.toFixed(0)} s. It must be at most ${max} s.` }
  return { ok: true }
}

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Whole seconds left until `expiresAtIso`, never negative; 0 if the date is unparseable (treated as expired). */
export function secondsLeft(expiresAtIso: string, nowMs: number): number {
  const t = Date.parse(expiresAtIso)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.ceil((t - nowMs) / 1000))
}

export const REFERENCE_FAILURE_ADVICE: Record<string, string> = {
  too_short: 'The reference is too short. Record or upload at least 8 seconds of continuous speech (30 to 60 seconds gives the best result).',
  too_long: 'The reference is too long. Use at most 120 seconds.',
  not_enough_speech: 'Less than half of the clip is speech. Talk continuously and keep pauses short.',
  too_noisy: 'Too much background noise. Find a quieter room, move closer to the microphone, and turn off fans and music.',
  clipped: 'The recording is distorted (too loud). Lower your input volume or move back from the microphone and record again.',
  multiple_speakers: 'More than one voice was detected. The reference must contain only the voice you are cloning.',
  music_detected: 'Music or background audio was detected. Use a clean recording of speech only.',
}

export function describeFailure(code: string, fallback?: string): string {
  return REFERENCE_FAILURE_ADVICE[code] ?? fallback ?? `The recording was rejected (${code}).`
}

export interface CloneErrorBody {
  error?: unknown
  message?: unknown
  code?: unknown
  details?: unknown
}

/** What the UI should do after an error. */
export type Recovery =
  | 'retry'            // same inputs can be sent again (transient)
  | 'new_challenge'    // get a new phrase, re-record consent; reference is kept
  | 'rerecord_consent' // same challenge still valid (attemptsLeft > 0); re-record consent; reference is kept
  | 'fix_reference'    // replace the reference; consent is kept while the phrase is still valid
  | 'fix_consent'      // consent clip unusable; re-record it
  | 'sign_in'
  | 'none'

export interface MappedError {
  code: string
  title: string
  message: string
  recovery: Recovery
  failures?: Array<{ code: string; advice: string }>
  attemptsLeft?: number
}

function failuresOf(details: unknown): Array<{ code: string; message?: string }> {
  const f = (details as { failures?: unknown } | null | undefined)?.failures
  if (!Array.isArray(f)) return []
  return f.flatMap((x) => (x && typeof (x as { code?: unknown }).code === 'string' ? [{ code: (x as { code: string }).code, message: typeof (x as { message?: unknown }).message === 'string' ? (x as { message: string }).message : undefined }] : []))
}

/**
 * Map a failed backend response to UI text. `body` is the parsed JSON (or null). Voice-clone routes answer
 * { error: text, code, details }; routes behind errorHandler (tts) answer { error: CODE, message: text }.
 */
export function mapCloneError(status: number, body: CloneErrorBody | null): MappedError {
  const bodyCode = typeof body?.code === 'string' ? body.code : ''
  const altCode = typeof body?.error === 'string' && typeof body?.message === 'string' ? body.error : ''
  const code = bodyCode || altCode || (status === 401 ? 'unauthenticated' : status === 0 ? 'network' : `http_${status}`)
  const serverText = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : ''
  const details = (body?.details ?? null) as { attemptsLeft?: unknown; limit?: unknown } | null
  const attemptsLeft = typeof details?.attemptsLeft === 'number' ? details.attemptsLeft : undefined

  switch (code) {
    case 'unauthenticated':
      return { code, title: 'Please sign in again', message: 'Your session expired or you are not signed in. Sign in and try again.', recovery: 'sign_in' }
    case 'email_unverified':
      return { code, title: 'Verify your email first', message: 'Voice cloning requires a verified email address. Open the confirmation email we sent when you signed up (check spam), click the link, then reload this page.', recovery: 'none' }
    case 'payment_required':
      return { code, title: 'A paid or complimentary account is required', message: 'Voice cloning needs a paid or comped account with an active plan. Your account does not have one yet. See pricing, or contact support@readaloudai.org if you think this is a mistake.', recovery: 'none' }
    case 'daily_limit': {
      const limit = typeof details?.limit === 'number' ? details.limit : undefined
      return { code, title: 'Daily limit reached', message: `You have reached the limit of ${limit ?? 'a few'} new voices per 24 hours (deleted voices still count). Try again tomorrow.`, recovery: 'none' }
    }
    case 'creation_in_progress':
      return { code, title: 'Another voice is being created', message: 'A voice creation is already running for your account. Wait a minute and try again.', recovery: 'retry' }
    case 'rate_limited':
      return { code, title: 'Too many requests', message: 'You have made too many requests in the last hour. Wait a while and try again.', recovery: 'none' }
    case 'unavailable':
    case 'CLONING_UNAVAILABLE':
      return { code, title: 'Voice cloning is not available right now', message: 'Voice cloning is switched off or not configured at the moment. Try again later or contact support@readaloudai.org.', recovery: 'none' }
    case 'service_unavailable':
      return { code, title: 'Cloning service unavailable', message: 'The voice service is starting up or temporarily down (a cold start can take up to 3 minutes). Your recordings are kept. Try again in a minute.', recovery: 'retry' }
    case 'asr_unavailable':
      return { code, title: 'Consent check unavailable', message: 'We could not verify the phrase because the speech recognition service is unavailable. Your recordings are kept. Try again shortly.', recovery: 'retry' }
    case 'challenge_expired':
      return { code, title: 'The phrase expired', message: 'The consent phrase is only valid for 5 minutes. Get a new phrase and record it again. Your reference recording is kept.', recovery: 'new_challenge' }
    case 'challenge_used':
    case 'challenge_not_found':
      return { code, title: 'Get a new phrase', message: 'This consent phrase can no longer be used (each phrase works once). Get a new phrase and record it again. Your reference recording is kept.', recovery: 'new_challenge' }
    case 'challenge_attempts_exhausted':
      return { code, title: 'No attempts left on this phrase', message: 'Too many failed attempts on this phrase. Get a new phrase and record it again. Your reference recording is kept.', recovery: 'new_challenge' }
    case 'phrase_mismatch': {
      const left = attemptsLeft
      if (left === 0) return { code, title: 'The phrase did not match', message: 'We could not match what you said to the phrase, and you have no attempts left on it. Get a new phrase.', recovery: 'new_challenge', attemptsLeft: 0 }
      return { code, title: 'The phrase did not match', message: `We could not match what you said to the phrase. Read it exactly as shown, including every code word, in a quiet room.${left !== undefined ? ` Attempts left on this phrase: ${left}.` : ''} Your reference recording is kept.`, recovery: 'rerecord_consent', attemptsLeft: left }
    }
    case 'speaker_mismatch': {
      const left = attemptsLeft
      const base = 'The voice in the consent recording does not sound like the voice in the reference. You can only clone your own voice. Record the phrase yourself, with the same microphone and in the same kind of room as the reference, or replace the reference with a recording of you.'
      if (left === 0) return { code, title: 'The voices did not match', message: `${base} You have no attempts left on this phrase, so get a new one.`, recovery: 'new_challenge', attemptsLeft: 0 }
      return { code, title: 'The voices did not match', message: `${base}${left !== undefined ? ` Attempts left on this phrase: ${left}.` : ''} Your reference recording is kept.`, recovery: 'rerecord_consent', attemptsLeft: left }
    }
    case 'reference_rejected': {
      const fs = failuresOf(body?.details)
      return {
        code, title: 'The reference recording cannot be used', message: 'Fix the problems below and record or upload a new reference. Your consent recording is kept while the phrase is still valid, and this did not use up a phrase attempt.',
        recovery: 'fix_reference', failures: (fs.length ? fs : [{ code: 'unknown' }]).map((f) => ({ code: f.code, advice: describeFailure(f.code, f.message) })),
      }
    }
    case 'consent_clip_rejected': {
      const fs = failuresOf(body?.details)
      return {
        code, title: 'The consent recording cannot be used', message: `Record the phrase again. It must be ${LIMITS.consentMinSec} to ${LIMITS.consentMaxSec} seconds of clear speech with no music. This did not use up a phrase attempt.`,
        recovery: 'fix_consent', failures: fs.map((f) => ({ code: f.code, advice: describeFailure(f.code, f.message) })),
      }
    }
    case 'audio_required':
      return { code, title: 'Both recordings are required', message: 'Both a consent recording and a reference recording are required (WAV, FLAC, OGG, MP3, M4A or WebM, at least a second long).', recovery: 'none' }
    case 'upload_error':
      return { code, title: 'Upload problem', message: status === 413 ? `A file is too large (max ${LIMITS.maxUploadBytes / 1024 / 1024} MB).` : (serverText || 'The upload could not be read. Use a WAV, FLAC, OGG, MP3, M4A or WebM file.'), recovery: 'fix_reference' }
    case 'unsupported_language':
      return { code, title: 'Language not supported', message: 'That language is not supported. Pick another from the list.', recovery: 'none' }
    case 'validation':
      return { code, title: 'Check the form', message: serverText || 'Some fields are invalid.', recovery: 'none' }
    case 'deletion_pending':
      return { code, title: 'Deletion is still finishing', message: 'The voice is already disabled and cannot be used, but the audio store did not confirm deletion. Press Delete again to retry.', recovery: 'retry' }
    case 'voice_not_found':
      return { code, title: 'Voice not found', message: 'This voice no longer exists. Refresh the list.', recovery: 'none' }
    case 'voice_disabled':
      return { code, title: 'Voice disabled', message: 'This voice has been disabled and cannot be used.', recovery: 'none' }
    case 'voice_unavailable':
      return { code, title: 'Voice is being deleted', message: 'This voice is being deleted and cannot be used.', recovery: 'none' }
    case 'network':
      return { code, title: 'Network problem', message: 'Could not reach the server. Check your connection. Your recordings are kept; try again.', recovery: 'retry' }
    case 'internal':
      return { code, title: 'Something went wrong', message: 'An unexpected error happened on our side. Try again in a moment.', recovery: 'retry' }
    default:
      if (status === 402) return { code, title: 'Plan required', message: serverText || 'This needs a paid or comped account with an active plan.', recovery: 'none' }
      if (status === 503 || status === 502 || status === 504) return { code, title: 'Service unavailable', message: serverText || 'The service is temporarily unavailable. Try again shortly.', recovery: 'retry' }
      return { code, title: 'Request failed', message: serverText || `Something went wrong (HTTP ${status}).`, recovery: 'none' }
  }
}

/** Pick a MediaRecorder MIME type the browser supports; the backend accepts webm, ogg and mp4/m4a. */
export function pickRecorderMime(isSupported: (t: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => isSupported(t))
}

export function extensionForMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('flac')) return 'flac'
  return 'wav'
}
