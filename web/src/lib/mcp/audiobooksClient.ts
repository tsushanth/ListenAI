// Client for this repo's backend Audiobooks MVP API (backend/src/routes/audiobooks.ts,
// mounted at /api/audiobooks behind requireAuthOrApiKey — see backend/src/index.ts and
// backend/src/middleware/apiKeyAuth.ts).
//
// This MCP server's identity is a *developer API key* (`ctx.apiKey`), which is a different
// credential from a Supabase session. requireAuthOrApiKey accepts a real Supabase JWT OR a
// gateway-forwarded-secret + resolved-identity header pair (never the raw key itself — see
// MCP_AUTH_BRIDGE.md at the repo root). So, like text_to_speech's use of upstream.ts's
// authorize(), we exchange the raw key for a short-lived gateway session token via the
// gateway's `/tts/authorize`, pull the `uid` (or `key_id`) claim out of that token, and
// forward the backend call with `x-gateway-admin-secret` + `x-gateway-uid`/`x-gateway-key-id`
// instead of `Authorization: Bearer <raw key>`.
//
// GATEWAY_FORWARD_SECRET must be provisioned to this web deployment's environment (it's the
// same shared secret backend/src/middleware/apiKeyAuth.ts checks) — see MCP_AUTH_BRIDGE.md's
// "what the MCP side still needs" section for the human call on whether that's the backend's
// own secret or a separate one scoped to "web MCP server → backend". Without it, every call
// below fails closed with 401 rather than forwarding the raw key as an invalid bearer token.

import { resolveGatewayIdentityHeaders as sharedResolveGatewayIdentityHeaders } from './upstream.ts'

// NOTE: fixed during a live redeploy debugging session — this defaulted to
// 'https://api.readaloudai.org' (the realtime-tts GATEWAY), but /api/audiobooks
// only exists on listenai-backend, not the gateway. Same class of bug already
// fixed once for sound-effects' upstream client.
const BACKEND_URL = process.env.AUDIOBOOKS_BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'
const REQUEST_TIMEOUT_MS = 30_000

export class AudiobooksApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Identity resolution (decoding the gateway session token's claims, falling back to the
// caller's key-id hash when there's no bound uid) used to be reimplemented here separately
// from upstream.ts's other bridged tools — including the bug that caused a live outage: this
// copy assumed a standard 3-part header.payload.signature JWT and always read split('.')[1] as
// the payload, but the real gateway token (confirmed by calling POST /tts/authorize directly)
// is 2-part, payload.signature, and this particular key's token carries only {id, exp} — no uid
// or key_id claim at all, so requiring one out of the token meant every unbound key 401'd with
// "Could not resolve an identity" (masked behind route.ts's generic "Invalid or revoked API
// key." because a 401 UpstreamError anywhere in a tool call sets ctx.authFailed, which
// overrides the real tool response with that message). Now consolidated into upstream.ts's
// resolveGatewayIdentityHeaders, which tries every dot-separated token segment and falls back
// to the caller-supplied keyId (ctx.keyId) rather than a locally re-derived hash — the same
// fallback identity every other bridged tool (isolate_voice, dub_audio, sound effects) now uses,
// so the same raw key resolves to the same backend identity regardless of which tool touched it
// first. It also reads MCP_GATEWAY_FORWARD_SECRET (not the unprefixed GATEWAY_FORWARD_SECRET
// this file used to read, which was never provisioned anywhere and always 401'd).

async function call<T>(apiKey: string, keyId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let identityHeaders: Record<string, string>
  try {
    identityHeaders = await sharedResolveGatewayIdentityHeaders(apiKey, keyId)
  } catch (e) {
    throw new AudiobooksApiError(401, e instanceof Error ? e.message : 'Could not resolve identity for this API key.')
  }

  let r: Response
  try {
    r = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...identityHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new AudiobooksApiError(0, 'Could not reach the audiobooks API. Try again shortly.')
  }

  const json = await r.json().catch(() => null) as Record<string, unknown> | null
  if (!r.ok) {
    const message = (json?.message as string | undefined) || (json?.error as string | undefined) || `Audiobooks API returned ${r.status}`
    throw new AudiobooksApiError(r.status, message)
  }
  return json as T
}

export interface AudiobookChapterStatus {
  sequence?: number
  sequence_index?: number
  title: string | null
  status: string
  duration_seconds?: number | null
  duration_sec?: number | null
  char_count?: number
}

export interface CreateAudiobookResult {
  audiobook_id: string
  status: string
  chapter_count: number
}

export interface AudiobookStatusResult {
  audiobook_id: string
  status: string
  chapter_count: number
  chapters_completed?: number
  chapters_ready?: number
  chapters_failed?: number
  overall_percentage?: number
  export_status?: string
  export_audio_path?: string | null
  chapters: AudiobookChapterStatus[]
  error?: { code?: string; message: string }
}

export interface ExportAudiobookResult {
  audiobook_id: string
  status?: string
  export_status?: string
  audio_url?: string
  duration_sec?: number
  duration_seconds?: number
}

export function createAudiobook(
  apiKey: string,
  keyId: string,
  params: { title: string; voice_id: string; speed?: number; text: string }
): Promise<CreateAudiobookResult> {
  return call(apiKey, keyId, 'POST', '/api/audiobooks', {
    title: params.title,
    voice_id: params.voice_id,
    speed: params.speed,
    source_type: 'text',
    text: params.text,
  })
}

export function getAudiobookStatus(apiKey: string, keyId: string, audiobookId: string): Promise<AudiobookStatusResult> {
  return call(apiKey, keyId, 'GET', `/api/audiobooks/${encodeURIComponent(audiobookId)}/status`)
}

export function exportAudiobook(apiKey: string, keyId: string, audiobookId: string): Promise<ExportAudiobookResult> {
  return call(apiKey, keyId, 'POST', `/api/audiobooks/${encodeURIComponent(audiobookId)}/export`)
}
