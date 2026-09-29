import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SlidingWindowLimiter } from './ratelimit.ts'
import {
  MAX_AUDIO_SECONDS, listVoicesInput, textToSpeechInput, textToSpeechSchema, MAX_TEXT_CHARS,
  soundEffectInput, soundEffectSchema, SOUND_EFFECT_MAX_DURATION_SEC,
  SOUND_EFFECT_POLL_TIMEOUT_MS, SOUND_EFFECT_POLL_INTERVAL_MS,
} from './schemas.ts'
import { KOKORO_VOICES, PIPER_VOICES, resolveVoice } from './voices.ts'
import {
  UpstreamError, authorize, fetchPiperHealth, synthesize, type ErrorCode,
  submitSoundEffectJob, pollSoundEffectJob, fetchAudioBytes,
} from './upstream.ts'
import { pcm16ToWav, pcmDurationSeconds } from './wav.ts'

// 15 speech calls per minute per API key (per server instance).
export const keyLimiter = new SlidingWindowLimiter(15, 60_000)
// Sound effect generation runs on a GPU worker per call — much more
// expensive than a TTS call, so a tighter limit than keyLimiter's.
export const soundEffectLimiter = new SlidingWindowLimiter(5, 60_000)

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
    instructions: 'ReadAloud AI text-to-speech. Use text_to_speech to turn short text into a WAV audio clip. Use list_voices before picking a non-default voice.',
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
      const submitted = await submitSoundEffectJob(ctx.apiKey, parsed.prompt, parsed.duration_sec)
      let result = submitted
      const deadline = Date.now() + SOUND_EFFECT_POLL_TIMEOUT_MS
      while (result.status !== 'ready' && result.status !== 'failed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SOUND_EFFECT_POLL_INTERVAL_MS))
        result = await pollSoundEffectJob(ctx.apiKey, result.job_id)
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

  return server
}
