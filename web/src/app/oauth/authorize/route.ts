import { NextRequest } from 'next/server'
import { baseUrl } from '@/lib/oauth/config'
import { oauthConfigured } from '@/lib/oauth/crypto'
import { validateAuthorize } from '@/lib/oauth/authorize'
import { SECURITY_HEADERS, errorPage } from '@/lib/oauth/page'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Validates the request, then hands off to the consent page. On ANY problem it renders an error page;
// it never redirects to a redirect_uri that has not been validated (no open redirect).
export function GET(req: NextRequest) {
  if (!oauthConfigured()) return errorPage('OAuth is not configured on this server.', 503)
  const q = req.nextUrl.searchParams
  const v = validateAuthorize(q)
  if (!v.ok) return errorPage(v.message, 400)
  const to = new URL(`${baseUrl()}/oauth/consent`)
  for (const k of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']) {
    const val = q.get(k)
    if (val !== null) to.searchParams.set(k, val)
  }
  return new Response(null, { status: 302, headers: { Location: to.toString(), 'Cache-Control': 'no-store', ...SECURITY_HEADERS } })
}
