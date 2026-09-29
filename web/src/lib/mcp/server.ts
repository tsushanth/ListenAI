import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SlidingWindowLimiter } from './ratelimit.ts'
import { MAX_AUDIO_SECONDS, listVoicesInput, textToSpeechInput, textToSpeechSchema, MAX_TEXT_CHARS, dubAudioInput, dubAudioSchema, dubStatusInput, dubStatusSchema, MAX_DUB_AUDIO_BYTES } from './schemas.ts'
import { KOKORO_VOICES, PIPER_VOICES, resolveVoice } from './voices.ts'
import { UpstreamError, authorize, fetchPiperHealth, synthesize, submitDub, getDubStatus, type ErrorCode } from './upstream.ts'
import { pcm16ToWav, pcmDurationSeconds } from './wav.ts'

// 15 speech calls per minute per API key (per server instance).
export const keyLimiter = new SlidingWindowLimiter(15, 60_000)

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
    instructions: 'ReadAloud AI text-to-speech and dubbing. Use text_to_speech to turn short text into a WAV audio clip. Use list_voices before picking a non-default voice. Use dub_audio to re-voice a spoken audio clip into another language (audio in, audio out — no video), then get_dub_status to poll for the result.',
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
      const result = await getDubStatus(ctx.apiKey, parsed.job_id)
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

  return server
}
