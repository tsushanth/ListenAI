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
// Audiobooks MVP (backend/src/routes/audiobooks.ts) — chapter detection +
// batch same-voice TTS per chapter + ffmpeg export. See audiobooksClient.ts
// for the open item on how this MCP server authenticates to that API.
// ============================================================================

export const MAX_AUDIOBOOK_TEXT_CHARS = 2_000_000

export const createAudiobookInput = {
  title: z.string().trim().min(1).max(500).describe('Audiobook title.'),
  text: z.string().trim().min(1).max(MAX_AUDIOBOOK_TEXT_CHARS)
    .describe('The full text to turn into an audiobook. It will be split into chapters automatically (by an LLM boundary call), then synthesized chapter by chapter with one fixed voice.'),
  voice_id: z.string().min(1).max(100).default('af_heart')
    .describe('Kokoro voice id used for every chapter (e.g. "af_heart", "am_adam"). Call list_voices for options.'),
  speed: z.number().min(0.5).max(3.0).default(1.0).describe('Speaking rate multiplier, applied to every chapter.'),
}
export const createAudiobookSchema = z.object(createAudiobookInput)

export const audiobookIdInput = {
  audiobook_id: z.string().uuid().describe('The audiobook id returned by create_audiobook.'),
}
export const audiobookIdSchema = z.object(audiobookIdInput)
