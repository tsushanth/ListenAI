import { TTS_REGISTRY } from '../../generated/tts-registry.ts'

// Voice lists come from the TTS registry (src/generated/tts-registry.json, written by scripts/sync-tts-registry.mjs), as the
// gateway lists them with voices the worker cannot speak left out. Do not hand-type a voice here.
const STUDIO = TTS_REGISTRY.engines.studio
const LIVE = TTS_REGISTRY.engines.live

/** Studio voices the docs and list_voices advertise (the registry's gateway catalog, unsupported voices hidden). */
export const KOKORO_VOICES: readonly string[] = STUDIO.voices.map((v) => v.id)
/** The voice names Live accepts without a `custom:` prefix. list_voices still returns only this (see LIVE_VOICES for the full list). */
export const PIPER_VOICES = ['default'] as const
/** Every Live voice the registry lists: the default English voice, then the beta voices in other languages. */
export const LIVE_VOICES: readonly string[] = [...(LIVE.defaultVoice ? [LIVE.defaultVoice.id] : []), ...LIVE.voices.map((v) => v.id)]
/**
 * Studio voices the registry lists on the API that the worker cannot speak. They are not advertised, but resolveVoice still passes
 * them upstream exactly as before this list existed (the gateway decides), so no caller that sends one gets a new local error.
 */
export const STUDIO_UNSUPPORTED_VOICES: readonly string[] = TTS_REGISTRY.hiddenUnsupportedVoiceIds.studio ?? []
export const DEFAULT_KOKORO_VOICE = 'af_heart'
export const CUSTOM_VOICE_RE = /^custom:[A-Za-z0-9_-]{1,64}$/

export type Engine = 'live' | 'studio'

/** The engine value sent to the gateway (the gateway still accepts the older names as aliases). */
export function upstreamEngine(engine: Engine): 'live' | 'studio' {
  return engine
}

/** Returns the voice to send upstream, or an error string for the model. */
export function resolveVoice(engine: Engine, voice: string | undefined): { voice: string } | { error: string } {
  const v = voice?.trim() || (engine === 'live' ? 'default' : DEFAULT_KOKORO_VOICE)
  if (CUSTOM_VOICE_RE.test(v)) return { voice: v }
  const known: readonly string[] = engine === 'live' ? LIVE_VOICES : KOKORO_VOICES
  if (known.includes(v)) return { voice: v }
  if (engine === 'studio' && STUDIO_UNSUPPORTED_VOICES.includes(v)) return { voice: v }
  return { error: `Unknown voice "${v}" for engine ${engine}. Valid: ${known.join(', ')}, or custom:<id>. Call list_voices to see them.` }
}
