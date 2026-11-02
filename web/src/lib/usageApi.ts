// Read-only client for GET {API}/api/usage, shown as the usage card on /app.
// Response (backend/src/routes/usage.ts): { current_month: "YYYY-MM", char_used: number, char_limit: number }.
//
// IMPORTANT: the backend's requireAuth treats a missing, empty or invalid bearer token as a shared default "pro" user
// instead of returning 401, so an anonymous call would succeed and return that shared account's numbers. This client
// therefore never calls the endpoint without a token: no token means 'anonymous' and no request is made.

export type UsageResult =
  | { status: 'anonymous' }
  | { status: 'ok'; usage: UsageSummary }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string }

export interface UsageSummary {
  /** "YYYY-MM" as reported by the API. */
  month: string
  used: number
  limit: number
  remaining: number
  /** 0-100, rounded; 100 when the limit is zero or exceeded. */
  percent: number
  /** About 750 characters of text per minute of audio (same figure the backend uses for its estimate). */
  minutesRemaining: number
}

export const CHARS_PER_MINUTE = 750

interface FetchOpts {
  apiUrl: string
  /** Supabase access token, or null/empty when signed out. */
  token: string | null | undefined
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/** Validate and shape the API payload; returns null when it is not the expected {month, used, limit}. */
export function parseUsage(payload: unknown): UsageSummary | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { current_month?: unknown; char_used?: unknown; char_limit?: unknown }
  if (typeof p.current_month !== 'string' || !/^\d{4}-\d{2}$/.test(p.current_month)) return null
  const used = p.char_used
  const limit = p.char_limit
  if (typeof used !== 'number' || typeof limit !== 'number') return null
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit < 0) return null
  const remaining = Math.max(0, limit - used)
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100
  return { month: p.current_month, used, limit, remaining, percent, minutesRemaining: Math.floor(remaining / CHARS_PER_MINUTE) }
}

export async function fetchUsage(opts: FetchOpts): Promise<UsageResult> {
  const token = (opts.token ?? '').trim()
  if (!token) return { status: 'anonymous' }
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(`${opts.apiUrl}/api/usage`, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, signal: opts.signal })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    return { status: 'error', message: 'Could not reach the server. Check your connection and try again.' }
  }
  if (res.status === 401 || res.status === 403) return { status: 'unauthorized' }
  if (res.status === 429) return { status: 'error', message: 'Too many requests. Please wait a moment and try again.' }
  if (!res.ok) return { status: 'error', message: 'Usage is unavailable right now. Please try again later.' }
  let body: unknown
  try { body = await res.json() } catch { return { status: 'error', message: 'Usage is unavailable right now. Please try again later.' } }
  const usage = parseUsage(body)
  if (!usage) return { status: 'error', message: 'Usage is unavailable right now. Please try again later.' }
  return { status: 'ok', usage }
}
