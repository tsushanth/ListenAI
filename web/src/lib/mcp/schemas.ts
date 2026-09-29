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

// ============================================================================
// Dubbing (v1: audio-in / audio-out re-voicing, no video)
// ============================================================================

// Base64-encoded audio keeps this a plain JSON tool call. Real dubbing jobs
// (minutes of audio) will be sizeable base64 payloads — MAX_DUB_AUDIO_BYTES
// caps the decoded size, checked server-side before forwarding upstream.
export const MAX_DUB_AUDIO_BYTES = 25 * 1024 * 1024 // 25 MB decoded

export const dubAudioInput = {
  audio_base64: z.string().min(1)
    .describe('Source audio, base64-encoded (wav, mp3, m4a, ogg, or flac). Up to ~25 MB decoded.'),
  filename: z.string().max(200).default('source-audio.mp3')
    .describe('Original filename, used only to infer the audio format.'),
  target_language: z.string().min(2).max(40)
    .describe('Language to dub INTO, e.g. "Spanish" or "es".'),
  source_language: z.string().min(2).max(10).optional()
    .describe('Language the source audio is in, e.g. "en". Omit to let the transcriber auto-detect.'),
  voice_id: z.string().min(1).max(100).optional()
    .describe('Kokoro voice id to speak the dub in. Omit for the default voice — this is not voice cloning; the dub will not sound like the original speaker.'),
}
export const dubAudioSchema = z.object(dubAudioInput)

export const dubStatusInput = {
  job_id: z.string().min(1).describe('The job_id returned by dub_audio.'),
}
export const dubStatusSchema = z.object(dubStatusInput)
