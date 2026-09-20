import { ACCESS_TTL_SEC, CODE_TTL_SEC, REFRESH_TTL_SEC, resourceUrl } from './config.ts'
import { hashId, nowSec, open, safeEqual, seal, signToken, verifySigned, verifyPkce } from './crypto.ts'
import type { ClientMeta } from './redirect.ts'

const P_CLIENT = 'rcl1', P_CODE = 'rac1', P_ACCESS = 'raa1', P_REFRESH = 'rar1'
export const ACCESS_PREFIX = P_ACCESS + '.'

// ---- client_id (stateless dynamic registration) ----
export const mintClientId = (meta: ClientMeta, iat = nowSec()) => signToken(P_CLIENT, { u: meta.redirect_uris, n: meta.client_name, iat })
export function readClientId(clientId: string): ClientMeta | null {
  if (typeof clientId !== 'string' || clientId.length > 4096) return null
  const p = verifySigned<{ u: string[]; n: string }>(P_CLIENT, clientId)
  if (!p || !Array.isArray(p.u) || typeof p.n !== 'string') return null
  return { redirect_uris: p.u, client_name: p.n }
}

export const normResource = (r: string) => r.replace(/\/+$/, '')
export const sameResource = (a: string, b: string) => normResource(a) === normResource(b)

// ---- authorization code (sealed; valid 60 s) ----
export interface CodeClaims { sub: string; cid: string; ru: string; cc: string; res: string; k: string; exp: number }
export function mintCode(c: { sub: string; clientId: string; redirectUri: string; codeChallenge: string; resource: string; apiKey: string }, now = nowSec()): string {
  const claims: CodeClaims = { sub: c.sub, cid: hashId(c.clientId), ru: c.redirectUri, cc: c.codeChallenge, res: c.resource, k: c.apiKey, exp: now + CODE_TTL_SEC }
  return seal(P_CODE, { t: 'code', ...claims })
}

export type GrantError = { error: 'invalid_grant' | 'invalid_request' | 'invalid_target'; description: string }
export const isGrantError = (x: CodeClaims | GrantError): x is GrantError => 'error' in x

export function redeemCode(code: string, p: { clientId: string; redirectUri: string; verifier: string; resource?: string }, now = nowSec()): CodeClaims | GrantError {
  const c = open<CodeClaims & { t: string }>(P_CODE, code)
  if (!c || c.t !== 'code' || typeof c.exp !== 'number') return { error: 'invalid_grant', description: 'Invalid authorization code' }
  if (c.exp <= now) return { error: 'invalid_grant', description: 'Authorization code expired' }
  if (!safeEqual(c.cid, hashId(p.clientId))) return { error: 'invalid_grant', description: 'client_id does not match the authorization code' }
  if (!safeEqual(c.ru, p.redirectUri)) return { error: 'invalid_grant', description: 'redirect_uri does not match the authorization request' }
  if (!verifyPkce(p.verifier, c.cc, 'S256')) return { error: 'invalid_grant', description: 'PKCE code_verifier does not match' }
  if (p.resource && !sameResource(p.resource, c.res)) return { error: 'invalid_target', description: 'resource does not match the authorization request' }
  return c
}

// ---- access / refresh tokens (sealed) ----
interface TokenClaims { t: 'at' | 'rt'; sub: string; aud: string; cid: string; k: string; iat: number; exp: number }
export function issueTokenPair(c: { sub: string; cidHash: string; apiKey: string }, now = nowSec()) {
  const aud = resourceUrl()
  const base = { sub: c.sub, aud, cid: c.cidHash, k: c.apiKey, iat: now }
  return {
    access_token: seal(P_ACCESS, { ...base, t: 'at', exp: now + ACCESS_TTL_SEC } as TokenClaims),
    token_type: 'Bearer' as const,
    expires_in: ACCESS_TTL_SEC,
    refresh_token: seal(P_REFRESH, { ...base, t: 'rt', exp: now + REFRESH_TTL_SEC } as TokenClaims),
  }
}

export type TokenCheck = { ok: true; sub: string; apiKey: string; cidHash: string } | { ok: false; reason: 'invalid' | 'expired' | 'audience' }
function check(prefix: string, type: 'at' | 'rt', token: string, now: number): TokenCheck {
  const c = open<TokenClaims>(prefix, token)
  if (!c || c.t !== type || typeof c.k !== 'string' || typeof c.exp !== 'number') return { ok: false, reason: 'invalid' }
  if (c.exp <= now) return { ok: false, reason: 'expired' }
  if (typeof c.aud !== 'string' || !safeEqual(c.aud, resourceUrl())) return { ok: false, reason: 'audience' }
  return { ok: true, sub: c.sub, apiKey: c.k, cidHash: c.cid }
}
export const verifyAccessToken = (t: string, now = nowSec()) => check(P_ACCESS, 'at', t, now)
export const verifyRefreshToken = (t: string, now = nowSec()) => check(P_REFRESH, 'rt', t, now)
export const looksLikeOAuthToken = (t: string) => t.startsWith(ACCESS_PREFIX)
