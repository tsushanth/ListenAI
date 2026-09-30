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

// ============================================================================
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

// ============================================================================
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

// ============================================================================
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
