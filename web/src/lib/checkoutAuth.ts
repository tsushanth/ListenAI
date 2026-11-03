// Server-side sign-in check for POST /api/checkout. The browser sends its Supabase access token as a bearer token; this asks
// Supabase who it belongs to (GET /auth/v1/user) rather than decoding the token locally, so a forged or expired token
// can never produce a user id that ends up in client_reference_id.

type HeaderBag = { get(name: string): string | null }

export function bearerToken(headers: HeaderBag): string | null {
  const m = /^Bearer ([^\s]+)$/i.exec((headers.get('authorization') ?? '').trim())
  return m ? m[1]! : null
}

export type VerifyResult =
  | { status: 'ok'; user: { id: string; email: string | null } }
  | { status: 'invalid' }
  /** Supabase could not be reached or answered 5xx: not the visitor's fault, so not "sign in again". */
  | { status: 'unavailable' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function verifySupabaseUser(
  token: string,
  opts: { supabaseUrl: string; anonKey: string; fetchImpl?: typeof fetch },
): Promise<VerifyResult> {
  if (!token.trim()) return { status: 'invalid' }
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${opts.supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: opts.anonKey } })
  } catch {
    return { status: 'unavailable' }
  }
  if (res.status >= 500) return { status: 'unavailable' }
  if (!res.ok) return { status: 'invalid' }
  const body = (await res.json().catch(() => null)) as { id?: unknown; email?: unknown } | null
  if (!body || typeof body.id !== 'string' || !UUID_RE.test(body.id)) return { status: 'invalid' }
  const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null
  return { status: 'ok', user: { id: body.id, email } }
}
