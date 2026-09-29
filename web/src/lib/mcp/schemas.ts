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

// Batch speech-to-text (worker-stt-prod via the gateway's /stt/authorize hand-off — see upstream.ts).
// Base64-encoded because MCP tool calls are JSON-RPC, not multipart file uploads.
export const MAX_STT_AUDIO_MB = 25
export const STT_REQUEST_TIMEOUT_MS = 120_000

export const speechToTextInput = {
  audio_base64: z.string().min(1)
    .describe(`Base64-encoded audio bytes (WAV, FLAC, OGG, MP3, M4A, or WEBM), up to ${MAX_STT_AUDIO_MB} MB decoded.`),
  mime_type: z.string().max(80).default('audio/wav')
    .describe('MIME type of the audio, e.g. "audio/wav", "audio/mpeg", "audio/webm".'),
  language: z.string().regex(/^[a-z]{2}$/).optional()
    .describe('ISO-639-1 language hint (e.g. "en"). Omit to auto-detect.'),
  word_timestamps: z.boolean().default(false)
    .describe('If true, include per-word start/end timestamps in the result.'),
}
export const speechToTextSchema = z.object(speechToTextInput)
