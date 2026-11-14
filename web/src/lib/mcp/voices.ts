import { TTS_REGISTRY } from '../../generated/tts-registry.ts'
import { TTS_LEGACY_VOICE_IDS } from '../../generated/tts-legacy-voice-ids.ts'

// Voice lists come from the public TTS catalog (src/generated/tts-registry.json, written by scripts/sync-tts-registry.mjs): a voice is
// its public id, name, language, dialect and gender, in the Live or the Studio tier. Do not hand-type a voice here.
// Old voice ids (src/generated/tts-legacy-voice-ids.ts) are still understood on input and mapped to the public id; they are never listed.
const STUDIO = TTS_REGISTRY.engines.studio
const LIVE = TTS_REGISTRY.engines.live

export type Engine = 'live' | 'studio'
export type PublicVoice = { voice_id: string; name: string; language: string; dialect?: string; gender: string }

const toPublic = (v: { id: string; name: string; language: string; gender: string; dialect?: string }): PublicVoice => {
  const o: PublicVoice = { voice_id: v.id, name: v.name, language: v.language, gender: v.gender }
  if (v.dialect) o.dialect = v.dialect
  return o
}

/** Studio voices the docs and list_voices advertise (public ids). The public catalog already leaves out voices the worker cannot speak. */
export const KOKORO_VOICES: readonly string[] = STUDIO.voices.map((v) => v.id)
/** Every Live voice the docs advertise: the default English voice, then the beta voices in other languages (public ids). */
export const LIVE_VOICES: readonly string[] = [...(LIVE.defaultVoice ? [LIVE.defaultVoice.id] : []), ...LIVE.voices.map((v) => v.id)]
/** What list_voices returns per tier: public ids with name, language, dialect and gender, nothing else. */
export const PUBLIC_VOICES: Readonly<Record<Engine, readonly PublicVoice[]>> = {
  live: [
    ...(LIVE.defaultVoice ? [{ voice_id: LIVE.defaultVoice.id, name: LIVE.defaultVoice.name, language: LIVE.defaultVoice.language, gender: 'female' }] : []),
    ...LIVE.voices.map(toPublic),
  ],
  studio: STUDIO.voices.map(toPublic),
}
export const DEFAULT_LIVE_VOICE = LIVE.defaultVoice ? LIVE.defaultVoice.id : LIVE.voices[0].id
export const DEFAULT_STUDIO_VOICE = KOKORO_VOICES.includes('en-heart') ? 'en-heart' : KOKORO_VOICES[0]
export const DEFAULT_KOKORO_VOICE = DEFAULT_STUDIO_VOICE
/** Old voice ids of live voices the catalog does not advertise (the worker cannot speak them). They are not listed, and a caller that sends one is still passed through. */
export const STUDIO_UNSUPPORTED_VOICES: readonly string[] = Object.entries(TTS_LEGACY_VOICE_IDS)
  .filter(([, t]) => t.tier === 'studio' && !KOKORO_VOICES.includes(t.id)).map(([old]) => old)
export const CUSTOM_VOICE_RE = /^custom:[A-Za-z0-9_-]{1,64}$/

/** The id the backend audiobook route knows for a public voice id (it still takes the old ids); anything else is passed through. */
export function backendVoiceId(voice: string): string {
  const old = Object.entries(TTS_LEGACY_VOICE_IDS).find(([, t]) => t.id === voice)
  return old ? old[0] : voice
}

/** The engine value sent to the gateway. */
export function upstreamEngine(engine: Engine): 'live' | 'studio' {
  return engine
}

/** Returns the voice to send upstream (always a public id when the voice is a built-in one), or an error string for the model. */
export function resolveVoice(engine: Engine, voice: string | undefined): { voice: string } | { error: string } {
  const v = voice?.trim() || (engine === 'live' ? DEFAULT_LIVE_VOICE : DEFAULT_STUDIO_VOICE)
  const known: readonly string[] = engine === 'live' ? LIVE_VOICES : KOKORO_VOICES
  if (known.includes(v)) return { voice: v }
  // An old id (for example one an existing client still sends) maps to its public id, in its own tier only.
  const old = Object.prototype.hasOwnProperty.call(TTS_LEGACY_VOICE_IDS, v) ? TTS_LEGACY_VOICE_IDS[v] : undefined
  if (old && old.tier === engine) return { voice: old.id }
  if (CUSTOM_VOICE_RE.test(v)) return { voice: v }
  return { error: `Unknown voice "${v}" for engine ${engine}. Valid: ${known.join(', ')}, or custom:<id>. Call list_voices to see them.` }
}
