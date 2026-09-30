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

import { createHash } from 'node:crypto'
import { authorize } from './upstream.ts'

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

/** Decodes a gateway session token's claims without verifying the signature — safe here because
 *  we only read it to forward an *already-trusted* identity (the gateway signed it after
 *  validating the raw key), never to authenticate the request ourselves.
 *
 *  NOTE: fixed during a live redeploy debugging session. This assumed a standard 3-part
 *  header.payload.signature JWT and always read split('.')[1] as the payload — but the real
 *  gateway token (confirmed by calling POST /tts/authorize directly) is 2-part,
 *  payload.signature, so the real claims are in split('.')[0], not [1]. On top of that, this
 *  particular key's token carries only {id, exp} - no uid or key_id claim at all - so even
 *  decoding the right segment yields nothing to key off. Now tries every dot-separated segment
 *  and returns the first one that parses as a JSON object, so it's not hostage to which segment
 *  position happens to hold the payload for a given token shape. */
function decodeJwtClaims(token: string): Record<string, unknown> {
  for (const segment of token.split('.')) {
    try {
      const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
      const json = Buffer.from(normalized, 'base64').toString('utf8')
      const parsed = JSON.parse(json) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // try the next segment
    }
  }
  return {}
}

/** Exchanges the raw API key for a gateway session token (same call upstream.ts's authorize()
 *  makes for TTS) and resolves the identity headers requireAuthOrApiKey expects from it. */
async function resolveGatewayIdentityHeaders(apiKey: string): Promise<Record<string, string>> {
  // Was reading GATEWAY_FORWARD_SECRET (unprefixed) - every other bridged tool
  // (isolate_voice, dub_audio, sound effects, and the top-level route.ts
  // connect-time check) reads MCP_GATEWAY_FORWARD_SECRET. The unprefixed var
  // was never provisioned anywhere, so this always 401'd - confirmed live,
  // masked behind route.ts's generic "Invalid or revoked API key." because a
  // 401 UpstreamError anywhere in a tool call sets ctx.authFailed, which
  // overrides the real tool response with that message.
  const forwardSecret = process.env.MCP_GATEWAY_FORWARD_SECRET
  if (!forwardSecret) {
    throw new AudiobooksApiError(
      401,
      'Audiobooks API access is not configured on this deployment (missing MCP_GATEWAY_FORWARD_SECRET).'
    )
  }

  // 'audiobooks' is not a real engine the gateway recognizes - it rejected
  // it with 401 every time, confirmed live against the deployed MCP server.
  // The other three bridged tools (isolate_voice, dub_audio, sound effects)
  // all use 'piper' here too: it's just used to authenticate the key via
  // the gateway's existing /tts/authorize, not to actually select an engine.
  const { token } = await authorize(apiKey, 'piper')
  const claims = decodeJwtClaims(token)
  const uid = typeof claims.uid === 'string' && claims.uid ? claims.uid : undefined
  // No token-carried key_id fallback anymore: this token's actual claims are
  // just {id, exp} - no uid, no key_id - so requiring one out of the token
  // meant every unbound key 401'd with "Could not resolve an identity",
  // confirmed live. Mirrors dub's resolveGatewayIdentity in upstream.ts: a
  // stable hash of the raw key itself is always available, so this path can
  // never fail to resolve *some* identity, bound or not.
  const keyId = uid ? undefined : createHash('sha256').update(apiKey).digest('hex').slice(0, 32)

  const headers: Record<string, string> = { 'x-gateway-admin-secret': forwardSecret }
  if (uid) headers['x-gateway-uid'] = uid
  else if (keyId) headers['x-gateway-key-id'] = keyId
  return headers
}

async function call<T>(apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const identityHeaders = await resolveGatewayIdentityHeaders(apiKey)

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
  params: { title: string; voice_id: string; speed?: number; text: string }
): Promise<CreateAudiobookResult> {
  return call(apiKey, 'POST', '/api/audiobooks', {
    title: params.title,
    voice_id: params.voice_id,
    speed: params.speed,
    source_type: 'text',
    text: params.text,
  })
}

export function getAudiobookStatus(apiKey: string, audiobookId: string): Promise<AudiobookStatusResult> {
  return call(apiKey, 'GET', `/api/audiobooks/${encodeURIComponent(audiobookId)}/status`)
}

export function exportAudiobook(apiKey: string, audiobookId: string): Promise<ExportAudiobookResult> {
  return call(apiKey, 'POST', `/api/audiobooks/${encodeURIComponent(audiobookId)}/export`)
}
