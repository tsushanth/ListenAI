// Kokoro v1.0 voice names, read from realtime-tts/worker/models/voices-v1.0.bin (kokoro-onnx).
// English voices only: prefix af/am = American female/male, bf/bm = British female/male.
export const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
] as const
export const PIPER_VOICES = ['default'] as const
export const DEFAULT_KOKORO_VOICE = 'af_heart'
export const CUSTOM_VOICE_RE = /^custom:[A-Za-z0-9_-]{1,64}$/

export type Engine = 'piper' | 'kokoro'

/** Returns the voice to send upstream, or an error string for the model. */
export function resolveVoice(engine: Engine, voice: string | undefined): { voice: string } | { error: string } {
  const v = voice?.trim() || (engine === 'piper' ? 'default' : DEFAULT_KOKORO_VOICE)
  if (CUSTOM_VOICE_RE.test(v)) return { voice: v }
  const known: readonly string[] = engine === 'piper' ? PIPER_VOICES : KOKORO_VOICES
  if (known.includes(v)) return { voice: v }
  return { error: `Unknown voice "${v}" for engine ${engine}. Valid: ${known.join(', ')}, or custom:<id>. Call list_voices to see them.` }
}
