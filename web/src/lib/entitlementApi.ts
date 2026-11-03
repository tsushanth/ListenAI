// Read-only client for GET {API}/api/entitlement (backend/src/routes/entitlement.ts).
// /success polls it and only says the plan is active when the backend shows an active Stripe entitlement for this account.
//
// The endpoint answers 401 without a valid token and the client never calls it without one: the legacy requireAuth maps a
// missing token to a shared default pro user, so any code path that skipped the token would "see" Pro for everyone.

export interface Entitlement {
  tier: string
  active: boolean
  webProEnabled: boolean
  /** True when the backend has an active Stripe (web) subscription for the signed-in account. */
  stripeActive: boolean
}

export type EntitlementResult =
  | { status: 'anonymous' }
  | { status: 'unauthorized' }
  | { status: 'ok'; entitlement: Entitlement }
  | { status: 'error'; message: string }

export function parseEntitlement(payload: unknown): Entitlement | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { tier?: unknown; active?: unknown; web_pro_enabled?: unknown; sources?: unknown }
  if (typeof p.tier !== 'string' || typeof p.active !== 'boolean' || !Array.isArray(p.sources)) return null
  const stripeActive = p.sources.some((s) => !!s && typeof s === 'object' && (s as { source?: unknown }).source === 'stripe' && (s as { active?: unknown }).active === true)
  return { tier: p.tier, active: p.active, webProEnabled: p.web_pro_enabled === true, stripeActive }
}

export async function fetchEntitlement(opts: { apiUrl: string; token: string | null | undefined; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<EntitlementResult> {
  const token = (opts.token ?? '').trim()
  if (!token) return { status: 'anonymous' }
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${opts.apiUrl}/api/entitlement`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: opts.signal })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    return { status: 'error', message: 'Could not reach the server.' }
  }
  if (res.status === 401) return { status: 'unauthorized' }
  if (!res.ok) return { status: 'error', message: `Something went wrong (HTTP ${res.status}).` }
  const entitlement = parseEntitlement(await res.json().catch(() => null))
  return entitlement ? { status: 'ok', entitlement } : { status: 'error', message: 'Unexpected response from the server.' }
}

export type WaitOutcome = 'active' | 'not_confirmed' | 'signed_out' | 'error' | 'cancelled'

/** Poll until the backend shows an active Stripe entitlement, the attempts run out, the user is signed out, or we are cancelled. */
export async function waitForEntitlement(opts: {
  apiUrl: string
  getToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  attempts: number
  intervalMs: number
  isCancelled: () => boolean
}): Promise<WaitOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastWasError = false
  for (let i = 0; i < opts.attempts; i++) {
    if (opts.isCancelled()) return 'cancelled'
    const token = await opts.getToken()
    const r = await fetchEntitlement({ apiUrl: opts.apiUrl, token, fetchImpl: opts.fetchImpl })
    if (r.status === 'anonymous' || r.status === 'unauthorized') return 'signed_out'
    if (r.status === 'ok' && r.entitlement.stripeActive) return 'active'
    lastWasError = r.status === 'error'
    if (i < opts.attempts - 1) await sleep(opts.intervalMs)
  }
  return lastWasError ? 'error' : 'not_confirmed'
}
