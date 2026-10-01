import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SlidingWindowLimiter } from './ratelimit.ts'
import {
  MAX_AUDIO_SECONDS, listVoicesInput, textToSpeechInput, textToSpeechSchema, MAX_TEXT_CHARS,
  createAudiobookInput, createAudiobookSchema, audiobookIdInput, audiobookIdSchema,
  isolateVoiceInput, isolateVoiceSchema, getVoiceIsolationInput, getVoiceIsolationSchema,
  MAX_ISOLATE_AUDIO_MB, ISOLATE_REQUEST_TIMEOUT_MS,
  speechToTextInput, speechToTextSchema, MAX_STT_AUDIO_MB, STT_REQUEST_TIMEOUT_MS,
  dubAudioInput, dubAudioSchema, dubStatusInput, dubStatusSchema, MAX_DUB_AUDIO_BYTES,
  soundEffectInput, soundEffectSchema, SOUND_EFFECT_MAX_DURATION_SEC,
  SOUND_EFFECT_POLL_TIMEOUT_MS, SOUND_EFFECT_POLL_INTERVAL_MS,
} from './schemas.ts'
import { KOKORO_VOICES, PIPER_VOICES, resolveVoice } from './voices.ts'
import {
  UpstreamError, authorize, authorizeStt, fetchPiperHealth, synthesize, transcribe, type ErrorCode,
  isolateVoice, getVoiceIsolationStatus, getVoiceIsolationAudio,
  submitDub, getDubStatus,
  submitSoundEffectJob, pollSoundEffectJob, fetchAudioBytes, resolveGatewayIdentityHeaders,
} from './upstream.ts'
import { manageDeployment, manageDeploymentInput, manageDeploymentSchema } from './deployments.ts'
import { pcm16ToWav, pcmDurationSeconds } from './wav.ts'
import { AudiobooksApiError, createAudiobook, getAudiobookStatus, exportAudiobook } from './audiobooksClient.ts'
import {
  designVoiceInput, designVoiceSchema, getVoiceDesignInput, getVoiceDesignSchema,
  convertVoiceInput, convertVoiceSchema, getVoiceConversionInput, getVoiceConversionSchema, MAX_CONVERT_AUDIO_MB,
  createVoiceCloneInput, createVoiceCloneSchema, uploadVoiceCloneDatasetInput, uploadVoiceCloneDatasetSchema,
  commitVoiceCloneDatasetInput, commitVoiceCloneDatasetSchema, voiceCloneIdInput, voiceCloneIdSchema,
  MAX_CLONE_ZIP_BASE64_MB, MAX_CLONE_ZIP_URL_MB, designKeyLimiter, convertKeyLimiter, cloneKeyLimiter,
  submitVoiceDesign, getVoiceDesignStatus, getVoiceDesignAudio,
  submitVoiceConversion, getVoiceConversionStatus, getVoiceConversionAudio,
  createVoiceClone, uploadVoiceCloneDataset, commitVoiceCloneDataset, getVoiceCloneStatus, deployVoiceClone, deleteVoiceClone,
  downloadZip, looksLikeZip,
} from './voiceTools.ts'

// 15 speech calls per minute per API key (per server instance).
export const keyLimiter = new SlidingWindowLimiter(15, 60_000)
// Sound effect generation runs on a GPU worker per call — much more
// expensive than a TTS call, so a tighter limit than keyLimiter's.
export const soundEffectLimiter = new SlidingWindowLimiter(5, 60_000)

// Isolation jobs run a GPU container per job: keep this tighter than speech. Mirrors the backend's own
// 10/hour limiter on POST /api/voice-isolate/isolations (voiceIsolate.ts), just scoped per-minute here
// since this limiter is local to one MCP server instance, not shared with the web app's own calls.
export const isolateKeyLimiter = new SlidingWindowLimiter(5, 60_000)

// Transcription is heavier (GPU minutes, not milliseconds) than a TTS call: 10 per minute per key.
export const sttKeyLimiter = new SlidingWindowLimiter(10, 60_000)

export interface RequestContext {
  keyId: string // hash of the API key, only used to bucket rate limits
  apiKey: string // used server-side only to call /tts/authorize
  authFailed?: boolean // set when upstream said 401, so the route can answer HTTP 401
}

function toolError(code: ErrorCode, message: string, retryable: boolean): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error (${code}): ${message}${retryable ? ' This is temporary; retry.' : ''}` }],
    structuredContent: { error: { code, message, retryable } },
  }
}

export function createMcpServer(ctx: RequestContext): McpServer {
  const server = new McpServer({ name: 'readaloud-ai', version: '1.0.0' }, {
    instructions: 'ReadAloud AI text-to-speech, speech-to-text, voice isolation, dubbing, sound effects, audiobooks, voice design, voice conversion and voice cloning. Use text_to_speech to turn short text into a WAV audio clip. Use list_voices before picking a non-default voice. Voice conversion, voice isolation, sound effects and dubbing each run on your own private GPU app: call manage_deployment (deploy) first, wait for status "ready", use the tool, then manage_deployment (teardown) when finished; it also stops automatically when idle. Use isolate_voice to separate vocals from a song/clip, then poll get_voice_isolation for the result. Use speech_to_text to transcribe spoken audio. Use create_audiobook to turn long text or an ePub into a chaptered audiobook, then get_audiobook_status and export_audiobook. Use dub_audio to re-voice a spoken audio clip into another language (audio in, audio out — no video), then get_dub_status to poll for the result. Use generate_sound_effect to make a short sound effect from a text description. Use design_voice to generate a synthetic voice from a description (poll get_voice_design), and convert_voice to re-speak a clip in a target voice (poll get_voice_conversion). To clone a voice: create_voice_clone, upload_voice_clone_dataset, commit_voice_clone_dataset (billed, needs confirms_charge), get_voice_clone_status until ready, then deploy_voice_clone and use custom:<voice_id> in text_to_speech; delete_voice_clone removes it.',
  })

  server.registerTool('text_to_speech', {
    title: 'Text to speech',
    description:
      `Convert text to spoken audio and return it as an inline WAV clip (24 kHz, mono, 16-bit). ` +
      `Limits: ${MAX_TEXT_CHARS} characters per call and about ${MAX_AUDIO_SECONDS} seconds of audio; longer audio is cut off, so split long text into several calls. ` +
      `Engines: "piper" is fast and cheap (one voice); "kokoro" sounds more natural and has many voices. ` +
      `The result also has a text block with duration and time to first audio. Uses the caller's free characters or billing, so avoid calling it repeatedly for the same text. ` +
      `Errors are returned with a code: capacity (temporary, retry), payment_required (free characters used up), invalid_voice (call list_voices), rate_limited (wait).`,
    inputSchema: textToSpeechInput,
    annotations: { title: 'Text to speech', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = textToSpeechSchema.parse(args)
    const rl = keyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many speech requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    const v = resolveVoice(parsed.engine, parsed.voice)
    if ('error' in v) return toolError('invalid_voice', v.error, false)
    try {
      const { token, url } = await authorize(ctx.apiKey, parsed.engine)
      const r = await synthesize({ url, token, text: parsed.text, voice: v.voice, speed: parsed.speed })
      const seconds = pcmDurationSeconds(r.pcm.length)
      return {
        content: [
          { type: 'audio', data: pcm16ToWav(r.pcm).toString('base64'), mimeType: 'audio/wav' },
          { type: 'text', text: `Spoke ${parsed.text.length} characters with ${parsed.engine}/${v.voice}: ${seconds.toFixed(1)} s of audio, first audio after ${r.ttfaMs} ms, total ${r.totalMs} ms.${r.truncated ? ` The audio was cut off at ${MAX_AUDIO_SECONDS} s; send the remaining text in another call.` : ''}` },
        ],
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while generating speech.', true)
    }
  })

  server.registerTool('manage_deployment', {
    title: 'Manage GPU deployment',
    description:
      `Bring up, check, or tear down the private GPU app behind convert_voice, isolate_voice, generate_sound_effect or dub_audio. ` +
      `These features run on an app that belongs to you: call with action "deploy" first (takes about 1-3 minutes), poll with ` +
      `action "status" until it is "ready", use the feature, then call with action "teardown" when finished. Usage is billed at ` +
      `the published per-use rates; it also stops automatically after an idle period or a maximum age. ` +
      `Errors: payment_required (add a payment method), rate_limited (deployment cap reached), capacity (not available right now).`,
    inputSchema: manageDeploymentInput,
    annotations: { title: 'Manage GPU deployment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = manageDeploymentSchema.parse(args)
    try {
      const headers = await resolveGatewayIdentityHeaders(ctx.apiKey, ctx.keyId)
      const out = await manageDeployment(parsed.service, parsed.action, headers)
      return { content: [{ type: 'text', text: out.text }], structuredContent: out.data }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while managing the deployment.', true)
    }
  })

  server.registerTool('isolate_voice', {
    title: 'Isolate voice',
    description:
      `Separate a song or clip's vocals from the rest (Demucs htdemucs). Send base64-encoded audio ` +
      `(WAV, FLAC, OGG, MP3, or M4A), up to ${MAX_ISOLATE_AUDIO_MB} MB decoded. Runs on a per-job GPU container, so it ` +
      `can take up to a minute or more depending on length; this call returns a job_id right away — poll ` +
      `get_voice_isolation with that job_id until status is "done", then call it again with fetch_audio ` +
      `to get the separated audio. Requires confirms_rights: true (you must have the legal right to use ` +
      `this audio). Set want_instrumental to also get the backing track, not just vocals. ` +
      `Uses the caller's active subscription, so avoid resubmitting the same audio. ` +
      `Errors are returned with a code: payment_required (no active subscription), invalid_input (bad audio ` +
      `or missing rights confirmation), rate_limited (wait).`,
    inputSchema: isolateVoiceInput,
    annotations: { title: 'Isolate voice', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = isolateVoiceSchema.parse(args)
    const rl = isolateKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many isolation requests for this key. Try again in ${rl.retryAfterSec} s.`, true)

    let buffer: Buffer
    try {
      buffer = Buffer.from(parsed.audio_base64, 'base64')
    } catch {
      return toolError('invalid_input', 'audio_base64 is not valid base64.', false)
    }
    if (buffer.length === 0) return toolError('invalid_input', 'Decoded audio is empty.', false)
    if (buffer.length > MAX_ISOLATE_AUDIO_MB * 1024 * 1024) {
      return toolError('invalid_input', `Decoded audio exceeds ${MAX_ISOLATE_AUDIO_MB} MB.`, false)
    }

    try {
      const result = await isolateVoice({
        apiKey: ctx.apiKey, keyId: ctx.keyId, buffer, mimeType: parsed.mime_type,
        wantInstrumental: parsed.want_instrumental, timeoutMs: ISOLATE_REQUEST_TIMEOUT_MS,
      })
      return {
        content: [{ type: 'text', text: `Isolation job ${result.job_id} is ${result.status}. Poll get_voice_isolation with job_id "${result.job_id}" for status and, once done, the separated audio.` }],
        structuredContent: { job_id: result.job_id, status: result.status },
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while submitting the isolation job.', true)
    }
  })

  server.registerTool('get_voice_isolation', {
    title: 'Get voice isolation status/result',
    description:
      `Check an isolate_voice job's status by job_id. While status is "queued" or "processing", returns ` +
      `just the status — poll again after a few seconds. Once status is "done", also returns the ` +
      `separated audio (the "vocals" stem by default, or "instrumental" if you passed want_instrumental to ` +
      `isolate_voice and set stem to "instrumental" here) as an inline WAV clip. If status is "failed" or ` +
      `"rejected", the job did not produce audio.`,
    inputSchema: getVoiceIsolationInput,
    annotations: { title: 'Get voice isolation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = getVoiceIsolationSchema.parse(args)
    try {
      const st = await getVoiceIsolationStatus({
        apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id, timeoutMs: ISOLATE_REQUEST_TIMEOUT_MS,
      })
      if (st.status !== 'done') {
        return {
          content: [{ type: 'text', text: `Isolation job ${parsed.job_id} is ${st.status}.${st.status === 'failed' || st.status === 'rejected' ? ` No audio was produced.${typeof st.error === 'string' ? ` (${st.error})` : ''}` : ' Poll again shortly.'}` }],
          structuredContent: { job_id: parsed.job_id, status: st.status },
        }
      }
      const audio = await getVoiceIsolationAudio({
        apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id, stem: parsed.stem, timeoutMs: ISOLATE_REQUEST_TIMEOUT_MS,
      })
      return {
        content: [
          { type: 'audio', data: audio.toString('base64'), mimeType: 'audio/wav' },
          { type: 'text', text: `Isolation job ${parsed.job_id} is done. Returning the ${parsed.stem} stem.` },
        ],
        structuredContent: { job_id: parsed.job_id, status: st.status, stem: parsed.stem },
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while checking the isolation job.', true)
    }
  })

  server.registerTool('speech_to_text', {
    title: 'Speech to text',
    description:
      `Transcribe spoken audio to text. Send base64-encoded audio (WAV, FLAC, OGG, MP3, M4A, or WEBM), up to ${MAX_STT_AUDIO_MB} MB decoded. ` +
      `Runs on a batch Whisper worker (large-v3-turbo) — expect a few seconds to a couple of minutes depending on length; long calls will not stream. ` +
      `Returns the transcript, detected language, and audio duration; set word_timestamps for per-word timing. ` +
      `Uses the caller's free minutes or billing, so avoid re-transcribing the same audio. ` +
      `Errors are returned with a code: capacity (temporary, retry), payment_required (free minutes used up), invalid_input (bad/oversized audio), rate_limited (wait).`,
    inputSchema: speechToTextInput,
    annotations: { title: 'Speech to text', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = speechToTextSchema.parse(args)
    const rl = sttKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many transcription requests for this key. Try again in ${rl.retryAfterSec} s.`, true)

    let buffer: Buffer
    try {
      buffer = Buffer.from(parsed.audio_base64, 'base64')
    } catch {
      return toolError('invalid_input', 'audio_base64 is not valid base64.', false)
    }
    if (buffer.length === 0) return toolError('invalid_input', 'Decoded audio is empty.', false)
    if (buffer.length > MAX_STT_AUDIO_MB * 1024 * 1024) {
      return toolError('invalid_input', `Decoded audio exceeds ${MAX_STT_AUDIO_MB} MB.`, false)
    }

    try {
      const { token, url } = await authorizeStt(ctx.apiKey)
      const result = await transcribe({
        url, token, buffer, mimeType: parsed.mime_type,
        language: parsed.language, wordTimestamps: parsed.word_timestamps,
        timeoutMs: STT_REQUEST_TIMEOUT_MS,
      })
      return {
        content: [
          { type: 'text', text: result.text },
          { type: 'text', text: `Detected language ${result.language}${result.language_probability ? ` (${(result.language_probability * 100).toFixed(0)}%)` : ''}, ${result.duration.toFixed(1)} s of audio.` },
        ],
        structuredContent: {
          text: result.text,
          language: result.language,
          language_probability: result.language_probability ?? null,
          duration: result.duration,
          words: result.words ?? undefined,
          segments: result.segments ?? undefined,
        },
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while transcribing audio.', true)
    }
  })

  server.registerTool('list_voices', {
    title: 'List voices',
    description: 'List the voices you can pass to text_to_speech, per engine. Custom trained voices are not listed; use "custom:<id>" if you have one. Kokoro voice names: af_/am_ = American female/male, bf_/bm_ = British female/male.',
    inputSchema: listVoicesInput,
    annotations: { title: 'List voices', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ engine }): Promise<CallToolResult> => {
    const out: Record<string, unknown> = {}
    if (!engine || engine === 'piper') out.piper = { voices: PIPER_VOICES, default: 'default' }
    if (!engine || engine === 'kokoro') out.kokoro = { voices: KOKORO_VOICES, default: 'af_heart' }
    out.custom = 'custom:<id>'
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out }
  })

  server.registerTool('get_api_status', {
    title: 'API status',
    description: 'Check whether the Piper engine is up and how busy it is (active vs maximum simultaneous streams). Call this when text_to_speech reports capacity errors. Kokoro load is not reported.',
    inputSchema: {},
    annotations: { title: 'API status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (): Promise<CallToolResult> => {
    const h = await fetchPiperHealth()
    const out = {
      piper: h ? { status: h.status ?? 'healthy', active_streams: h.active, max_streams: h.max, busy: h.active >= h.max } : { status: 'unreachable' },
      kokoro: { status: 'not reported', note: 'Runs on a GPU worker that can need a few extra seconds to wake after idle.' },
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out }
  })

  // ==========================================================================
  // Audiobooks MVP — chapter detection + batch same-voice TTS + ffmpeg export.
  // See audiobooksClient.ts for the open item on API-key -> backend identity.
  // ==========================================================================

  server.registerTool('create_audiobook', {
    title: 'Create audiobook',
    description:
      'Turn long text into an audiobook: splits it into chapters and synthesizes each chapter with the same voice. ' +
      'Returns immediately with an audiobook_id — chapter synthesis runs in the background; poll get_audiobook_status until every chapter is ready, then call export_audiobook.',
    inputSchema: createAudiobookInput,
    annotations: { title: 'Create audiobook', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = createAudiobookSchema.parse(args)
    try {
      const result = await createAudiobook(ctx.apiKey, ctx.keyId, parsed)
      return {
        content: [{ type: 'text', text: `Created audiobook ${result.audiobook_id} with ${result.chapter_count} chapter(s), status: ${result.status}. Poll get_audiobook_status with this id.` }],
        structuredContent: result as unknown as Record<string, unknown>,
      }
    } catch (e) {
      if (e instanceof AudiobooksApiError) {
        if (e.status === 401) ctx.authFailed = true
        return toolError('upstream', e.message, e.status === 0 || e.status >= 500)
      }
      return toolError('upstream', 'Unexpected error while creating the audiobook.', true)
    }
  })

  server.registerTool('get_audiobook_status', {
    title: 'Get audiobook status',
    description: 'Check chapter-by-chapter synthesis progress for an audiobook created with create_audiobook. Status moves pending -> processing -> completed (or failed if a chapter synthesis fails).',
    inputSchema: audiobookIdInput,
    annotations: { title: 'Get audiobook status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = audiobookIdSchema.parse(args)
    try {
      const result = await getAudiobookStatus(ctx.apiKey, ctx.keyId, parsed.audiobook_id)
      const readyCount = result.chapters_completed ?? result.chapters_ready ?? result.chapters.filter((c) => c.status === 'ready').length
      return {
        content: [{ type: 'text', text: `Audiobook ${result.audiobook_id}: ${result.status} (${readyCount}/${result.chapter_count} chapters ready).${result.error ? ` Error: ${result.error.message}` : ''}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      }
    } catch (e) {
      if (e instanceof AudiobooksApiError) {
        if (e.status === 401) ctx.authFailed = true
        if (e.status === 404) return toolError('invalid_input', 'No audiobook found with that id.', false)
        return toolError('upstream', e.message, e.status === 0 || e.status >= 500)
      }
      return toolError('upstream', 'Unexpected error while checking audiobook status.', true)
    }
  })

  server.registerTool('export_audiobook', {
    title: 'Export audiobook',
    description: 'Concatenate every chapter of a completed audiobook into a single MP3 with chapter markers, and return a download URL. Call get_audiobook_status first — every chapter must be "ready".',
    inputSchema: audiobookIdInput,
    annotations: { title: 'Export audiobook', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = audiobookIdSchema.parse(args)
    try {
      const result = await exportAudiobook(ctx.apiKey, ctx.keyId, parsed.audiobook_id)
      return {
        content: [{ type: 'text', text: result.audio_url ? `Exported audiobook ${result.audiobook_id}: ${result.audio_url}` : `Export status for ${result.audiobook_id}: ${result.export_status ?? result.status}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      }
    } catch (e) {
      if (e instanceof AudiobooksApiError) {
        if (e.status === 401) ctx.authFailed = true
        if (e.status === 404) return toolError('invalid_input', 'No audiobook found with that id.', false)
        if (e.status === 400 || e.status === 422) return toolError('invalid_input', e.message, false)
        return toolError('upstream', e.message, e.status === 0 || e.status >= 500)
      }
      return toolError('upstream', 'Unexpected error while exporting the audiobook.', true)
    }
  })

  server.registerTool('dub_audio', {
    title: 'Dub audio into another language',
    description:
      `Submit a short spoken-audio clip to be re-voiced in another language: transcribes it, translates each segment, and ` +
      `synthesizes the translation with roughly the same segment timing as the source (speed-matched per segment, not true forced ` +
      `alignment). Audio in, audio out only — no video muxing or subtitles. Returns a job_id immediately; call get_dub_status to poll ` +
      `for the result. This is NOT voice cloning: the dub uses a standard voice, not the original speaker's voice, unless you already ` +
      `have a cloned voice_id. Errors are returned with a code: capacity (temporary, retry), payment_required, rate_limited (wait).`,
    inputSchema: dubAudioInput,
    annotations: { title: 'Dub audio', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = dubAudioSchema.parse(args)
    const rl = keyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many requests for this key. Try again in ${rl.retryAfterSec} s.`, true)

    const decodedBytes = Math.floor((parsed.audio_base64.length * 3) / 4)
    if (decodedBytes > MAX_DUB_AUDIO_BYTES) {
      return toolError('invalid_input', `Decoded audio is too large (~${Math.round(decodedBytes / 1024 / 1024)} MB, max ${Math.round(MAX_DUB_AUDIO_BYTES / 1024 / 1024)} MB).`, false)
    }

    try {
      const result = await submitDub({
        key: ctx.apiKey,
        keyId: ctx.keyId,
        audioBase64: parsed.audio_base64,
        filename: parsed.filename,
        targetLanguage: parsed.target_language,
        sourceLanguage: parsed.source_language,
        voiceId: parsed.voice_id,
      })
      return {
        content: [
          { type: 'text', text: `Dubbing job submitted: ${result.job_id} (status: ${result.status}). Call get_dub_status with this job_id to check progress and get the result.` },
        ],
        structuredContent: { ...result },
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while submitting the dubbing job.', true)
    }
  })

  server.registerTool('get_dub_status', {
    title: 'Get dubbing job status',
    description: 'Poll a dubbing job started by dub_audio. Returns "processing", "ready" (with an audio_url to download), or "failed" (with an error message).',
    inputSchema: dubStatusInput,
    annotations: { title: 'Get dubbing job status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = dubStatusSchema.parse(args)
    try {
      const result = await getDubStatus(ctx.apiKey, ctx.keyId, parsed.job_id)
      const summary = result.status === 'ready'
        ? `Dub ready: ${result.audio_url}`
        : result.status === 'failed'
          ? `Dub failed: ${result.error ?? 'unknown error'}`
          : 'Dub still processing.'
      return { content: [{ type: 'text', text: summary }], structuredContent: { ...result } }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while checking the dubbing job.', true)
    }
  })

  server.registerTool('generate_sound_effect', {
    title: 'Generate sound effect',
    description:
      `Generate a short sound effect clip (e.g. "glass shattering", "footsteps on gravel", "door creaking open") from a text description, and return it as an inline WAV clip. ` +
      `Not for music or songs — describe a sound event, not a musical style or lyrics. ` +
      `Duration: 1-${SOUND_EFFECT_MAX_DURATION_SEC} seconds (default 3s). Generation runs on a GPU worker and can take up to ${Math.round(SOUND_EFFECT_POLL_TIMEOUT_MS / 1000)}s; ` +
      `if it doesn't finish in time, the result includes a job id and the caller should be told generation is still in progress rather than assuming failure. ` +
      `Uses the caller's billing, so avoid calling it repeatedly for the same prompt/duration — identical requests are cached and not re-billed. ` +
      `Errors are returned with a code: capacity (temporary, retry), payment_required (subscription required), rate_limited (wait).`,
    inputSchema: soundEffectInput,
    annotations: { title: 'Generate sound effect', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = soundEffectSchema.parse(args)
    const rl = soundEffectLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many sound effect requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      // Resolve the gateway-forwarded identity headers once and reuse them
      // across the submit + poll calls below, rather than re-exchanging the
      // API key with the gateway on every poll.
      const identityHeaders = await resolveGatewayIdentityHeaders(ctx.apiKey, ctx.keyId)
      const submitted = await submitSoundEffectJob(identityHeaders, parsed.prompt, parsed.duration_sec)
      let result = submitted
      const deadline = Date.now() + SOUND_EFFECT_POLL_TIMEOUT_MS
      while (result.status !== 'ready' && result.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SOUND_EFFECT_POLL_INTERVAL_MS))
        result = await pollSoundEffectJob(identityHeaders, result.job_id)
      }
      if (result.status === 'failed') {
        return toolError('upstream', result.error?.message ?? 'Sound effect generation failed.', true)
      }
      if (result.status !== 'ready' || !result.audio_url) {
        // Still generating past our poll budget — hand back the job id rather
        // than blocking the tool call indefinitely.
        return {
          content: [{ type: 'text', text: `Still generating (job ${result.job_id}). This can take a bit longer than ${Math.round(SOUND_EFFECT_POLL_TIMEOUT_MS / 1000)}s for a cold GPU worker — tell the user generation is in progress rather than that it failed.` }],
          structuredContent: { job_id: result.job_id, status: result.status },
        }
      }
      const wav = await fetchAudioBytes(result.audio_url)
      return {
        content: [
          { type: 'audio', data: wav.toString('base64'), mimeType: 'audio/wav' },
          { type: 'text', text: `Generated a ${parsed.duration_sec}s sound effect for "${parsed.prompt}".${result.cache_hit ? ' (cache hit — not re-billed)' : ''}` },
        ],
      }
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.code === 'unauthorized') ctx.authFailed = true
        return toolError(e.code, e.message, e.retryable)
      }
      return toolError('upstream', 'Unexpected error while generating a sound effect.', true)
    }
  })

  // ==========================================================================
  // Voice design, voice conversion and voice cloning. Contiguous block at the end of the registrations;
  // schemas, limiters and upstream clients live in voiceTools.ts.
  // ==========================================================================

  const failVoice = (e: unknown, fallback: string): CallToolResult => {
    if (e instanceof UpstreamError) {
      if (e.code === 'unauthorized') ctx.authFailed = true
      return toolError(e.code, e.message, e.retryable)
    }
    return toolError('upstream', fallback, true)
  }
  const decodedBytes = (b64: string) => Math.floor((b64.length * 3) / 4)

  server.registerTool('design_voice', {
    title: 'Design a voice',
    description:
      `Generate a brand-new synthetic voice from a text description (e.g. "a warm, friendly female narrator with a calm British accent") ` +
      `and have it speak a sample sentence. Runs on a GPU worker; this call returns a job_id right away. Poll get_voice_design with that job_id ` +
      `until it returns the WAV audio. Billed per generated voice on the caller's active subscription, so avoid resubmitting the same description. ` +
      `Errors are returned with a code: payment_required (no active subscription), invalid_input (description/text too short or long), rate_limited (wait).`,
    inputSchema: designVoiceInput,
    annotations: { title: 'Design a voice', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = designVoiceSchema.parse(args)
    const rl = designKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice design requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      const r = await submitVoiceDesign({ apiKey: ctx.apiKey, keyId: ctx.keyId, description: parsed.description, text: parsed.text })
      return {
        content: [{ type: 'text', text: `Voice design job ${r.job_id} is ${r.status}. Poll get_voice_design with job_id "${r.job_id}" for the audio.` }],
        structuredContent: { job_id: r.job_id, status: r.status },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while submitting the voice design job.') }
  })

  server.registerTool('get_voice_design', {
    title: 'Get voice design status/result',
    description:
      `Check a design_voice job by job_id. While status is "queued" or "processing" it returns just the status: poll again after a few seconds. ` +
      `Once status is "ready" it also returns the generated voice sample as an inline WAV clip. Polling a finished job again is safe and is not billed twice.`,
    inputSchema: getVoiceDesignInput,
    annotations: { title: 'Get voice design', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = getVoiceDesignSchema.parse(args)
    try {
      const st = await getVoiceDesignStatus({ apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id })
      if (st.status !== 'ready') {
        return {
          content: [{ type: 'text', text: `Voice design job ${parsed.job_id} is ${st.status}.${st.status === 'failed' ? ' No audio was produced.' : ' Poll again shortly.'}` }],
          structuredContent: { job_id: parsed.job_id, status: st.status },
        }
      }
      const audio = await getVoiceDesignAudio({ apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id })
      return {
        content: [
          { type: 'audio', data: audio.toString('base64'), mimeType: 'audio/wav' },
          { type: 'text', text: `Voice design job ${parsed.job_id} is ready.` },
        ],
        structuredContent: { job_id: parsed.job_id, status: st.status },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while checking the voice design job.') }
  })

  server.registerTool('convert_voice', {
    title: 'Convert voice',
    description:
      `Speech-to-speech voice conversion (Seed-VC): re-speak the source audio in the voice of a target reference clip, keeping the words and timing. ` +
      `Send both clips base64-encoded (WAV, FLAC, OGG, MP3, or M4A), up to ${MAX_CONVERT_AUDIO_MB} MB decoded each. Requires confirms_rights: true. ` +
      `Returns a job_id right away; poll get_voice_conversion. First use on an account provisions a private GPU converter automatically (about 3 minutes): ` +
      `in that case this returns a temporary "capacity" error, and you should call convert_voice again after a few minutes. ` +
      `Errors are returned with a code: payment_required (no active subscription), invalid_input (bad audio or missing rights confirmation), capacity (converter still being set up, retry), rate_limited (wait).`,
    inputSchema: convertVoiceInput,
    annotations: { title: 'Convert voice', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = convertVoiceSchema.parse(args)
    const rl = convertKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice conversion requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    const limit = MAX_CONVERT_AUDIO_MB * 1024 * 1024
    if (decodedBytes(parsed.source_audio_base64) > limit || decodedBytes(parsed.target_audio_base64) > limit) {
      return toolError('invalid_input', `Each clip must be at most ${MAX_CONVERT_AUDIO_MB} MB decoded.`, false)
    }
    const source = Buffer.from(parsed.source_audio_base64, 'base64')
    const target = Buffer.from(parsed.target_audio_base64, 'base64')
    if (source.length === 0 || target.length === 0) return toolError('invalid_input', 'Decoded audio is empty.', false)
    try {
      const r = await submitVoiceConversion({
        apiKey: ctx.apiKey, keyId: ctx.keyId,
        source, sourceMime: parsed.source_mime_type, target, targetMime: parsed.target_mime_type,
      })
      return {
        content: [{ type: 'text', text: `Voice conversion job ${r.job_id} is ${r.status}. Poll get_voice_conversion with job_id "${r.job_id}" for the audio.` }],
        structuredContent: { job_id: r.job_id, status: r.status },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while submitting the voice conversion job.') }
  })

  server.registerTool('get_voice_conversion', {
    title: 'Get voice conversion status/result',
    description:
      `Check a convert_voice job by job_id. While status is "queued" or "processing" it returns just the status: poll again after a few seconds. ` +
      `Once status is "done" it also returns the converted speech as an inline WAV clip. If status is "failed" or "rejected" no audio was produced. ` +
      `Polling a finished job again is safe and is not billed twice.`,
    inputSchema: getVoiceConversionInput,
    annotations: { title: 'Get voice conversion', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = getVoiceConversionSchema.parse(args)
    try {
      const st = await getVoiceConversionStatus({ apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id })
      if (st.status !== 'done') {
        const bad = st.status === 'failed' || st.status === 'rejected'
        return {
          content: [{ type: 'text', text: `Voice conversion job ${parsed.job_id} is ${st.status}.${bad ? ' No audio was produced.' : ' Poll again shortly.'}` }],
          structuredContent: { job_id: parsed.job_id, status: st.status },
        }
      }
      const audio = await getVoiceConversionAudio({ apiKey: ctx.apiKey, keyId: ctx.keyId, jobId: parsed.job_id })
      return {
        content: [
          { type: 'audio', data: audio.toString('base64'), mimeType: 'audio/wav' },
          { type: 'text', text: `Voice conversion job ${parsed.job_id} is done.` },
        ],
        structuredContent: { job_id: parsed.job_id, status: st.status },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while checking the voice conversion job.') }
  })

  server.registerTool('create_voice_clone', {
    title: 'Create a voice clone',
    description:
      `Start a custom cloned voice (Piper fine-tune) for a speaker who has agreed to it. Records the speaker's consent and returns a voice_id; ` +
      `next call upload_voice_clone_dataset, then commit_voice_clone_dataset (that step starts training and bills $2.50 per voice). ` +
      `Needs a billing-enabled API key and at most 3 active voices per key. You must pass consent: true and the consent_statement verbatim; ` +
      `only clone a voice you are authorized to. Errors are returned with a code: payment_required (billing not enabled on this key), invalid_input (names too short or consent wording wrong), rate_limited (wait).`,
    inputSchema: createVoiceCloneInput,
    annotations: { title: 'Create voice clone', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = createVoiceCloneSchema.parse(args)
    const rl = cloneKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice cloning requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      const r = await createVoiceClone({
        apiKey: ctx.apiKey, speakerName: parsed.speaker_name, attestedBy: parsed.attested_by, consentStatement: parsed.consent_statement,
      })
      return {
        content: [{ type: 'text', text: `Created voice ${r.id} (status: created). Next: upload_voice_clone_dataset with voice_id "${r.id}".` }],
        structuredContent: { voice_id: r.id, status: 'created' },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while creating the voice clone.') }
  })

  server.registerTool('upload_voice_clone_dataset', {
    title: 'Upload voice clone recordings',
    description:
      `Upload the recordings for a voice made with create_voice_clone: a ZIP of clean, single-speaker WAV/FLAC/MP3 files (10-60 minutes is ideal). ` +
      `Provide exactly one of zip_base64 (up to ${MAX_CLONE_ZIP_BASE64_MB} MB decoded) or zip_url (public https URL, up to ${MAX_CLONE_ZIP_URL_MB} MB). ` +
      `This only uploads; it does not start training or bill anything. Call commit_voice_clone_dataset afterwards. ` +
      `Errors are returned with a code: invalid_input (not a ZIP, too large, or the voice already has recordings), payment_required, rate_limited (wait).`,
    inputSchema: uploadVoiceCloneDatasetInput,
    annotations: { title: 'Upload voice clone dataset', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = uploadVoiceCloneDatasetSchema.parse(args)
    const rl = cloneKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice cloning requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    if (!!parsed.zip_base64 === !!parsed.zip_url) return toolError('invalid_input', 'Provide exactly one of zip_base64 or zip_url.', false)
    try {
      let zip: Buffer
      if (parsed.zip_base64) {
        if (decodedBytes(parsed.zip_base64) > MAX_CLONE_ZIP_BASE64_MB * 1024 * 1024) {
          return toolError('invalid_input', `zip_base64 exceeds ${MAX_CLONE_ZIP_BASE64_MB} MB decoded. Host the ZIP at an https URL and pass zip_url instead.`, false)
        }
        zip = Buffer.from(parsed.zip_base64, 'base64')
      } else {
        zip = await downloadZip(parsed.zip_url as string)
      }
      if (!looksLikeZip(zip)) return toolError('invalid_input', 'The data is not a ZIP archive.', false)
      const r = await uploadVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: parsed.voice_id, zip })
      return {
        content: [{ type: 'text', text: `Uploaded ${r.bytes} bytes (${r.parts} part${r.parts === 1 ? '' : 's'}) for voice ${parsed.voice_id}. Next: commit_voice_clone_dataset (starts training, bills $2.50).` }],
        structuredContent: { voice_id: parsed.voice_id, uploaded_bytes: r.bytes, parts: r.parts },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while uploading the recordings.') }
  })

  server.registerTool('commit_voice_clone_dataset', {
    title: 'Commit voice clone and start training',
    description:
      `Finish the upload for a voice and start training (about 30-60 minutes on GPU). THIS BILLS $2.50 (one-time, per voice) to the account behind this API key, ` +
      `so it requires confirms_charge: true; call it once per voice. Poll get_voice_clone_status until status is "ready", then deploy_voice_clone to use it. ` +
      `Errors are returned with a code: payment_required (billing not enabled), invalid_input (nothing uploaded, or already committed), rate_limited (wait).`,
    inputSchema: commitVoiceCloneDatasetInput,
    annotations: { title: 'Commit voice clone dataset', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = commitVoiceCloneDatasetSchema.parse(args)
    const rl = cloneKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice cloning requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      const r = await commitVoiceCloneDataset({ apiKey: ctx.apiKey, voiceId: parsed.voice_id })
      return {
        content: [{ type: 'text', text: `Training started for voice ${r.id} (status: ${r.status}${r.clips !== undefined ? `, ${r.clips} clips` : ''}). Poll get_voice_clone_status; expect roughly 30-60 minutes.` }],
        structuredContent: { voice_id: r.id, status: r.status, clips: r.clips ?? null },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while starting training.') }
  })

  server.registerTool('get_voice_clone_status', {
    title: 'Get voice clone status',
    description:
      `Check a cloned voice: status moves created -> training -> ready (or rejected, with a reason if the recordings could not be used). ` +
      `When ready, call deploy_voice_clone, then use "custom:<voice_id>" as the voice in text_to_speech.`,
    inputSchema: voiceCloneIdInput,
    annotations: { title: 'Get voice clone status', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = voiceCloneIdSchema.parse(args)
    try {
      const v = await getVoiceCloneStatus({ apiKey: ctx.apiKey, voiceId: parsed.voice_id })
      const reason = v.error && typeof v.error === 'object' ? (v.error as { reason?: string }).reason : undefined
      return {
        content: [{ type: 'text', text: `Voice ${v.id}: ${v.status ?? 'unknown'}.${reason ? ` ${reason}` : ''}${v.status === 'ready' ? ' Call deploy_voice_clone to make it usable.' : ''}` }],
        structuredContent: v as Record<string, unknown>,
      }
    } catch (e) { return failVoice(e, 'Unexpected error while checking the voice clone.') }
  })

  server.registerTool('deploy_voice_clone', {
    title: 'Deploy voice clone',
    description:
      `Make a trained (status "ready") cloned voice available for synthesis. Returns the voice name to pass to text_to_speech, in the form "custom:<voice_id>". No extra charge.`,
    inputSchema: voiceCloneIdInput,
    annotations: { title: 'Deploy voice clone', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = voiceCloneIdSchema.parse(args)
    const rl = cloneKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice cloning requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      const r = await deployVoiceClone({ apiKey: ctx.apiKey, voiceId: parsed.voice_id })
      return {
        content: [{ type: 'text', text: `Voice ${r.id} is live. Use voice "${r.voice}" in text_to_speech.` }],
        structuredContent: { voice_id: r.id, voice: r.voice },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while deploying the voice clone.') }
  })

  server.registerTool('delete_voice_clone', {
    title: 'Delete voice clone',
    description:
      `Permanently delete a cloned voice and its recordings. This cannot be undone and does not refund the $2.50 creation charge.`,
    inputSchema: voiceCloneIdInput,
    annotations: { title: 'Delete voice clone', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (args): Promise<CallToolResult> => {
    const parsed = voiceCloneIdSchema.parse(args)
    const rl = cloneKeyLimiter.check(ctx.keyId)
    if (!rl.ok) return toolError('rate_limited', `Too many voice cloning requests for this key. Try again in ${rl.retryAfterSec} s.`, true)
    try {
      await deleteVoiceClone({ apiKey: ctx.apiKey, voiceId: parsed.voice_id })
      return {
        content: [{ type: 'text', text: `Deleted voice ${parsed.voice_id}.` }],
        structuredContent: { voice_id: parsed.voice_id, deleted: true },
      }
    } catch (e) { return failVoice(e, 'Unexpected error while deleting the voice clone.') }
  })

  return server
}
