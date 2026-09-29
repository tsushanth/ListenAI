import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { SlidingWindowLimiter } from './ratelimit.ts'
import { MAX_AUDIO_SECONDS, listVoicesInput, textToSpeechInput, textToSpeechSchema, MAX_TEXT_CHARS, createAudiobookInput, createAudiobookSchema, audiobookIdInput, audiobookIdSchema } from './schemas.ts'
import { KOKORO_VOICES, PIPER_VOICES, resolveVoice } from './voices.ts'
import { UpstreamError, authorize, fetchPiperHealth, synthesize, type ErrorCode } from './upstream.ts'
import { pcm16ToWav, pcmDurationSeconds } from './wav.ts'
import { AudiobooksApiError, createAudiobook, getAudiobookStatus, exportAudiobook } from './audiobooksClient.ts'

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
      const result = await createAudiobook(ctx.apiKey, parsed)
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
      const result = await getAudiobookStatus(ctx.apiKey, parsed.audiobook_id)
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
      const result = await exportAudiobook(ctx.apiKey, parsed.audiobook_id)
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

  return server
}
