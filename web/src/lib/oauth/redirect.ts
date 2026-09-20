// redirect_uri and dynamic client registration (RFC 7591) validation.
export const MAX_REDIRECT_URIS = 5
export const MAX_REDIRECT_LEN = 300
export const MAX_NAME_LEN = 80
// Custom URI schemes used by desktop clients. Anything else (javascript:, data:, file:, ...) is refused.
export const ALLOWED_CUSTOM_SCHEMES = ['cursor', 'vscode', 'vscode-insiders', 'vscodium', 'windsurf', 'zed', 'positron', 'kiro', 'trae']
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

const hasControlOrForbidden = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c <= 0x20 || c === 0x7f || c === 0x5c /* \ */ || c === 0x2a /* * */) return true
  }
  return false
}

/** Returns an error string, or null when the URI is acceptable to register. */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri) return 'redirect_uri must be a non-empty string'
  if (uri.length > MAX_REDIRECT_LEN) return 'redirect_uri too long'
  if (hasControlOrForbidden(uri)) return 'redirect_uri contains forbidden characters (whitespace, backslash or wildcard)'
  let u: URL
  try { u = new URL(uri) } catch { return 'redirect_uri is not a valid absolute URI' }
  if (uri.includes('#') || u.hash) return 'redirect_uri must not contain a fragment'
  if (u.username || u.password) return 'redirect_uri must not contain credentials'
  const scheme = u.protocol.slice(0, -1)
  if (scheme === 'https') return u.hostname ? null : 'redirect_uri needs a host'
  if (scheme === 'http') return LOOPBACK.has(u.hostname) ? null : 'http redirect_uri is only allowed for localhost, 127.0.0.1 or [::1]'
  if (ALLOWED_CUSTOM_SCHEMES.includes(scheme)) return null
  return `redirect_uri scheme "${scheme}" is not allowed`
}

export interface ClientMeta { redirect_uris: string[]; client_name: string }

export function cleanClientName(v: unknown): string {
  let s = ''
  if (typeof v === 'string') {
    for (const ch of v) {
      const c = ch.charCodeAt(0)
      if (c < 0x20 || c === 0x7f || '<>"\'`\\'.includes(ch)) continue
      s += ch
    }
  }
  s = s.replace(/\s+/g, ' ').trim()
  return (s || 'MCP client').slice(0, MAX_NAME_LEN)
}

type RegErr = 'invalid_redirect_uri' | 'invalid_client_metadata'
export type RegResult = { ok: true; meta: ClientMeta } | { ok: false; error: RegErr; description: string }

export function validateRegistration(body: unknown): RegResult {
  const bad = (error: RegErr, description: string): RegResult => ({ ok: false, error, description })
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_client_metadata', 'Body must be a JSON object')
  const b = body as Record<string, unknown>
  const uris = b.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0) return bad('invalid_redirect_uri', 'redirect_uris must be a non-empty array')
  if (uris.length > MAX_REDIRECT_URIS) return bad('invalid_redirect_uri', `At most ${MAX_REDIRECT_URIS} redirect_uris`)
  for (const u of uris) { const p = redirectUriProblem(u); if (p) return bad('invalid_redirect_uri', p) }
  const method = b.token_endpoint_auth_method
  if (method !== undefined && method !== 'none') return bad('invalid_client_metadata', 'Only token_endpoint_auth_method "none" (public client + PKCE) is supported')
  if (b.grant_types !== undefined && (!Array.isArray(b.grant_types) || !b.grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
    return bad('invalid_client_metadata', 'grant_types may only contain authorization_code and refresh_token')
  }
  if (b.response_types !== undefined && (!Array.isArray(b.response_types) || !b.response_types.every((g) => g === 'code'))) {
    return bad('invalid_client_metadata', 'response_types may only contain code')
  }
  if (b.client_name !== undefined && typeof b.client_name !== 'string') return bad('invalid_client_metadata', 'client_name must be a string')
  return { ok: true, meta: { redirect_uris: Array.from(new Set(uris as string[])), client_name: cleanClientName(b.client_name) } }
}
