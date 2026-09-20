import { NextRequest } from 'next/server'
import { clientIp, configured, json, notConfigured, oauthError, preflight, registerLimiter } from '@/lib/oauth/http'
import { validateRegistration } from '@/lib/oauth/redirect'
import { mintClientId } from '@/lib/oauth/tokens'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const OPTIONS = preflight

// RFC 7591 dynamic client registration, stateless: client_id is an HMAC-signed token that carries the
// registered redirect URIs and name. Public clients only (no secret).
export async function POST(req: NextRequest) {
  if (!configured()) return notConfigured()
  const rl = registerLimiter.check(clientIp(req))
  if (!rl.ok) return oauthError('temporarily_unavailable', 'Too many registrations. Try again later.', 429, { 'Retry-After': String(rl.retryAfterSec) })
  const raw = await req.text()
  if (raw.length > 8192) return oauthError('invalid_client_metadata', 'Body too large')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return oauthError('invalid_client_metadata', 'Body must be JSON') }
  const v = validateRegistration(body)
  if (!v.ok) return oauthError(v.error, v.description)
  return json({
    client_id: mintClientId(v.meta),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: v.meta.client_name,
    redirect_uris: v.meta.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, 201)
}
