import { resourceUrl } from './config.ts'
import { isValidChallenge, safeEqual } from './crypto.ts'
import { readClientId, sameResource } from './tokens.ts'

export interface AuthorizeParams {
  clientId: string; clientName: string; redirectUri: string; codeChallenge: string
  state: string | null; resource: string; scope: string | null
}
export type AuthorizeCheck = { ok: true; p: AuthorizeParams } | { ok: false; message: string }

const g = (q: URLSearchParams, k: string) => q.get(k) ?? ''

/** Validates an authorization request. On failure the caller MUST show an error page, never redirect. */
export function validateAuthorize(q: URLSearchParams): AuthorizeCheck {
  const clientId = g(q, 'client_id')
  const client = clientId ? readClientId(clientId) : null
  if (!client) return { ok: false, message: 'Unknown or invalid client_id. Remove and re-add the connector in your app.' }
  const redirectUri = g(q, 'redirect_uri')
  if (!redirectUri || !client.redirect_uris.some((u) => safeEqual(u, redirectUri))) return { ok: false, message: 'redirect_uri does not exactly match one registered for this client.' }
  if (g(q, 'response_type') !== 'code') return { ok: false, message: 'Only response_type=code is supported.' }
  if (g(q, 'code_challenge_method') !== 'S256') return { ok: false, message: 'PKCE with code_challenge_method=S256 is required.' }
  const cc = g(q, 'code_challenge')
  if (!isValidChallenge(cc)) return { ok: false, message: 'A valid S256 code_challenge is required.' }
  const resource = q.get('resource')
  if (resource && !sameResource(resource, resourceUrl())) return { ok: false, message: 'Unknown resource. This server only issues tokens for ' + resourceUrl() }
  const state = q.get('state')
  if (state && state.length > 1024) return { ok: false, message: 'state is too long.' }
  return { ok: true, p: { clientId, clientName: client.client_name, redirectUri, codeChallenge: cc, state, resource: resourceUrl(), scope: q.get('scope') } }
}

export function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri)
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v)
  return u.toString()
}
