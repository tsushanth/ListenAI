import { NextRequest } from 'next/server'
import { ApproveError, approve } from '@/lib/oauth/approve'
import { getApproveDeps } from '@/lib/oauth/deps'
import { approveLimiter, clientIp, configured, json, notConfigured } from '@/lib/oauth/http'
import { SECURITY_HEADERS } from '@/lib/oauth/page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Called by the consent page with the signed-in user's Supabase access token in an Authorization header
// (never a cookie, so a cross-site form post cannot ride the user's session: CSRF-safe). No CORS headers
// are sent, so other origins cannot read the response either. The OAuth params are re-validated here.
export async function POST(req: NextRequest) {
  const h = { ...SECURITY_HEADERS }
  if (!configured()) return notConfigured()
  const rl = approveLimiter.check(clientIp(req))
  if (!rl.ok) return json({ error: 'Too many attempts. Wait a minute and retry.' }, 429, h)
  const m = /^Bearer\s+(\S{10,4096})$/i.exec(req.headers.get('authorization') || '')
  if (!m) return json({ error: 'Please sign in again.' }, 401, h)
  let body: { params?: unknown }
  try { body = await req.json() } catch { return json({ error: 'Bad request.' }, 400, h) }
  if (typeof body.params !== 'string' || body.params.length > 8192) return json({ error: 'Bad request.' }, 400, h)
  try {
    const out = await approve(getApproveDeps(), m[1], new URLSearchParams(body.params))
    return json(out, 200, h)
  } catch (e) {
    if (e instanceof ApproveError) return json({ error: e.message }, e.status, h)
    return json({ error: 'Something went wrong. Try again.' }, 500, h)
  }
}
