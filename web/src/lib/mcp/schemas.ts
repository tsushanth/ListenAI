import { z } from 'zod'

export const MAX_TEXT_CHARS = 1000
export const MAX_AUDIO_SECONDS = 20
export const REQUEST_TIMEOUT_MS = 30_000

export const engineSchema = z.enum(['piper', 'kokoro'])

export const textToSpeechInput = {
  text: z.string().trim().min(1, 'text must not be empty').max(MAX_TEXT_CHARS, `text must be at most ${MAX_TEXT_CHARS} characters`)
    .describe(`The exact words to speak, plain text, 1-${MAX_TEXT_CHARS} characters (about 20 s of audio at most; longer audio is cut off). Split longer content into several calls. Do not include markup.`),
  engine: engineSchema.default('piper')
    .describe('"piper" (default): fast CPU engine, one voice ("default"), lowest latency, cheapest. "kokoro": more natural, many voices, may be slower to start.'),
  voice: z.string().max(80).optional()
    .describe('Voice name. Piper: "default". Kokoro: e.g. "af_heart" (default), "am_adam", "bf_emma". Custom trained voices: "custom:<id>". Call list_voices for the full list.'),
  speed: z.number().min(0.5).max(2).default(1)
    .describe('Speaking rate multiplier, 0.5 (slow) to 2.0 (fast). Default 1.0.'),
}
export const textToSpeechSchema = z.object(textToSpeechInput)

export const listVoicesInput = {
  engine: engineSchema.optional().describe('Only list voices for this engine. Omit to list both.'),
}
export const listVoicesSchema = z.object(listVoicesInput)

// Sound effect generation — mirrors backend/src/routes/soundEffects.ts's own
// MIN/MAX_DURATION_SEC exactly (1-12s; sound effects are much shorter clips
// than the text-to-music feature's 15-47s range). Keep these in sync with
// that file if either changes.
export const SOUND_EFFECT_MIN_DURATION_SEC = 1
export const SOUND_EFFECT_MAX_DURATION_SEC = 12
// Generation runs on a GPU worker and is not instant like TTS; the tool
// polls internally for up to this long before giving up and returning a
// job id for the caller to check back on later.
export const SOUND_EFFECT_POLL_TIMEOUT_MS = 45_000
export const SOUND_EFFECT_POLL_INTERVAL_MS = 2_000

export const soundEffectInput = {
  prompt: z.string().trim().min(1, 'prompt must not be empty').max(500, 'prompt must be at most 500 characters')
    .describe('A short description of the desired sound effect, e.g. "glass shattering on concrete" or "footsteps on gravel". Not song lyrics or musical style — for music, a separate tool would be needed.'),
  duration_sec: z.number().min(SOUND_EFFECT_MIN_DURATION_SEC).max(SOUND_EFFECT_MAX_DURATION_SEC).default(3)
    .describe(`Length of the generated clip in seconds, ${SOUND_EFFECT_MIN_DURATION_SEC}-${SOUND_EFFECT_MAX_DURATION_SEC}. Default 3s. Most one-shot effects (a click, a door slam) need well under 5s.`),
}
export const soundEffectSchema = z.object(soundEffectInput)
