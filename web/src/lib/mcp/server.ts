import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SlidingWindowLimiter } from './ratelimit.ts'
import { MAX_AUDIO_SECONDS, listVoicesInput, textToSpeechInput, textToSpeechSchema, MAX_TEXT_CHARS } from './schemas.ts'
import { KOKORO_VOICES, PIPER_VOICES, resolveVoice } from './voices.ts'
import { UpstreamError, authorize, fetchPiperHealth, synthesize, type ErrorCode } from './upstream.ts'
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

  return server
}
