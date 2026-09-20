import { NextRequest } from 'next/server'
import { hashId } from '@/lib/oauth/crypto'
import { clientIp, configured, json, notConfigured, oauthError, preflight, readParams, tokenLimiter } from '@/lib/oauth/http'
import { isGrantError, issueTokenPair, readClientId, redeemCode, sameResource, verifyRefreshToken } from '@/lib/oauth/tokens'
import { resourceUrl } from '@/lib/oauth/config'
import { UpstreamError, authorize } from '@/lib/mcp/upstream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = preflight

// Stateless token endpoint (public clients, PKCE). Note: a stateless authorization code cannot be marked
// single-use; it is bounded by a 60 s TTL and PKCE. Refresh tokens are "rotated" (a new one is issued
// each time) but the old one stays valid until it expires, since there is nowhere to record use.
export async function POST(req: NextRequest) {
  if (!configured()) return notConfigured()
  const rl = tokenLimiter.check(clientIp(req))
  if (!rl.ok) return oauthError('temporarily_unavailable', 'Too many requests.', 429, { 'Retry-After': String(rl.retryAfterSec) })
  const p = await readParams(req)
  if (!p) return oauthError('invalid_request', 'Malformed request body')

  if (p.resource && !sameResource(p.resource, resourceUrl())) return oauthError('invalid_target', 'Unknown resource')

  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.client_id || !p.redirect_uri || !p.code_verifier) return oauthError('invalid_request', 'code, client_id, redirect_uri and code_verifier are required')
    if (!readClientId(p.client_id)) return oauthError('invalid_client', 'Unknown client_id', 401)
    const c = redeemCode(p.code, { clientId: p.client_id, redirectUri: p.redirect_uri, verifier: p.code_verifier, resource: p.resource })
    if (isGrantError(c)) return oauthError(c.error, c.description)
    return json(issueTokenPair({ sub: c.sub, cidHash: c.cid, apiKey: c.k }))
  }

  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return oauthError('invalid_request', 'refresh_token is required')
    const t = verifyRefreshToken(p.refresh_token)
    if (!t.ok) return oauthError('invalid_grant', t.reason === 'expired' ? 'Refresh token expired' : 'Invalid refresh token')
    if (p.client_id && hashId(p.client_id) !== t.cidHash) return oauthError('invalid_grant', 'client_id does not match the refresh token')
    // Tokens are stateless, so revocation lives in the embedded API key. Check it is still live so a
    // revoked connector gets invalid_grant here and the client restarts the login instead of looping.
    try { await authorize(t.apiKey, 'piper') } catch (e) {
      if (e instanceof UpstreamError && e.code === 'unauthorized') return oauthError('invalid_grant', 'This connector was revoked. Reconnect it to sign in again.')
      // Other upstream failures (capacity, 402, network) do not mean the key is dead: still refresh.
    }
    return json(issueTokenPair({ sub: t.sub, cidHash: t.cidHash, apiKey: t.apiKey }))
  }

  return oauthError('unsupported_grant_type', 'Supported: authorization_code, refresh_token')
}
