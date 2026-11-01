// Text normalization for the ReadAloud Live (Piper) worker.
//
// The worker only normalizes text ("9 AM" -> "nine A M", "Dr." -> "Doctor", phone numbers, "ext.", units) when a
// request carries a `normalize` field; with no field it speaks the raw text. Our own clients therefore ask for
// `normalize: "auto"` on English voices. The worker's normalizer has English and Spanish rules only and picks the
// rules from `language_code`, not from the voice, so we never send it for a voice that may not be English.
//
// An explicit value from the caller always wins, including "off".

export type NormalizeMode = 'auto' | 'basic' | 'off'

export const NORMALIZE_MODES: readonly NormalizeMode[] = ['auto', 'basic', 'off']

/**
 * True when `voice` is known to speak English on the Piper worker: no voice, "default" (or any non-`custom:` name,
 * which the worker maps to its default English voice), or a `custom:en-*` house voice. Other `custom:` ids
 * (de/fr/es/it/pt-BR house voices, user clones of unknown language) are treated as not English.
 */
export function isEnglishPiperVoice(voice: string | undefined | null): boolean {
  const v = (voice ?? '').trim().toLowerCase()
  if (!v.startsWith('custom:')) return true
  return v.startsWith('custom:en-')
}

/**
 * The extra fields to spread into a Piper `synthesize` message / `/v1/tts/stream` body.
 * `{}` means "leave the field out" (worker default).
 */
export function piperNormalizeFields(voice: string | undefined | null, override?: NormalizeMode | null): { normalize?: NormalizeMode } {
  if (override) return { normalize: override }
  return isEnglishPiperVoice(voice) ? { normalize: 'auto' } : {}
}

/** The JSON text of a Piper `synthesize` WebSocket message, with the normalize field when one applies. */
export function buildSynthesizeMessage(opts: { text: string; voice: string; speed: number; normalize?: NormalizeMode | null }): string {
  return JSON.stringify({ type: 'synthesize', text: opts.text, voice: opts.voice, speed: opts.speed, ...(opts.normalize ? { normalize: opts.normalize } : {}) })
}
