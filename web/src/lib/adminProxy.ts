export interface ForwardArgs { fetchImpl?: typeof fetch; backendBase: string; authorization: string | null; range: string | null }
export interface ForwardResult { status: number; body: string; contentType: string }

export const ADMIN_PROXY_TIMEOUT_MS = 20000 // backend probes (up to 4 s) now overlap the data fetch; listUsers can still be slow
const RANGES = new Set(['24h', '7d', '30d'])

export async function forwardAdminDashboard({ fetchImpl = fetch, backendBase, authorization, range }: ForwardArgs): Promise<ForwardResult> {
  if (!authorization?.startsWith('Bearer ')) return { status: 404, body: 'Not found', contentType: 'text/plain' }
  const qs = range && RANGES.has(range) ? `?range=${range}` : ''
  try {
    const res = await fetchImpl(`${backendBase.replace(/\/$/, '')}/api/admin/dashboard${qs}`, {
      headers: { Authorization: authorization }, cache: 'no-store', signal: AbortSignal.timeout(ADMIN_PROXY_TIMEOUT_MS),
    })
    return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') ?? 'application/json' }
  } catch {
    return { status: 502, body: JSON.stringify({ error: 'dashboard unavailable' }), contentType: 'application/json' }
  }
}
