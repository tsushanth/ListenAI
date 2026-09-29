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

// Vocal isolation (Demucs htdemucs), proxied through backend/src/routes/voiceIsolate.ts rather than a
// gateway-authorized worker — see upstream.ts's isolateVoice()/getVoiceIsolation() for why. Base64-encoded
// for the same reason as speech_to_text: MCP tool calls are JSON-RPC, not multipart uploads.
// Bounded well under this route's MAX_BODY_BYTES (see route.ts) since the whole JSON-RPC request,
// base64 overhead included, has to fit in one body.
export const MAX_ISOLATE_AUDIO_MB = 8
export const ISOLATE_REQUEST_TIMEOUT_MS = 60_000

export const isolateVoiceInput = {
  audio_base64: z.string().min(1)
    .describe(`Base64-encoded audio bytes (WAV, FLAC, OGG, MP3, or M4A), up to ${MAX_ISOLATE_AUDIO_MB} MB decoded.`),
  mime_type: z.string().max(80).default('audio/wav')
    .describe('MIME type of the audio, e.g. "audio/wav", "audio/mpeg", "audio/x-m4a".'),
  want_instrumental: z.boolean().default(false)
    .describe('If true, also separate the instrumental/background stem, not just vocals.'),
  confirms_rights: z.literal(true)
    .describe('Must be true: you confirm you have the legal right to use this audio and that isolating its vocal track does not infringe anyone else\'s rights.'),
}
export const isolateVoiceSchema = z.object(isolateVoiceInput)

export const getVoiceIsolationInput = {
  job_id: z.string().min(1).max(200).describe('The job_id returned by isolate_voice.'),
  stem: z.enum(['vocals', 'instrumental']).default('vocals')
    .describe('Which separated stem to fetch once the job is done. Ignored while the job is still running.'),
}
export const getVoiceIsolationSchema = z.object(getVoiceIsolationInput)
