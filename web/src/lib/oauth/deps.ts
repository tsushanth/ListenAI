// Real dependencies for /oauth/approve (Supabase user verification + the same backend endpoints the
// developer console uses), plus a test-only seam. The test seam is refused in production: it needs
// OAUTH_TEST_MODE=1 AND NODE_ENV !== 'production', otherwise the real deps are always used.
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../supabaseConfig.ts'
import { ApproveError, type ApproveDeps } from './approve.ts'

const API_BASE = () => process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

async function backend(token: string, path: string, init: RequestInit = {}) {
  let res: Response
  try {
    res = await fetch(`${API_BASE()}/api/tts-api-keys${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ApproveError(502, 'Could not reach the ReadAloud AI backend. Try again shortly.')
  }
  if (res.status === 401) throw new ApproveError(401, 'Please sign in again.')
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: string } | null
    // Key cap (429) and other backend messages are already readable; pass them to the consent page.
    throw new ApproveError(res.status === 429 ? 429 : 502, e?.error || `The backend returned ${res.status}.`)
  }
  return res.json()
}

export const realDeps: ApproveDeps = {
  async verifyUser(token) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      if (!r.ok) return null
      const u = (await r.json()) as { id?: string }
      return typeof u.id === 'string' ? u.id : null
    } catch { return null }
  },
  async listKeys(token) {
    const d = (await backend(token, '')) as { keys: { id: string; label: string | null; revoked: boolean }[] }
    return d.keys
  },
  async revokeKey(token, id) { await backend(token, `/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
  async createKey(token, label) {
    const d = (await backend(token, '', { method: 'POST', body: JSON.stringify({ label }) })) as { key: string }
    if (!d.key) throw new ApproveError(502, 'The backend did not return a key.')
    return { key: d.key }
  },
}

// In-memory fake: token "test-user:<id>" is a valid user; keys are fake and never touch any backend.
const fakeKeys: { id: string; sub: string; label: string; revoked: boolean }[] = []
export const testDeps: ApproveDeps = {
  async verifyUser(token) { return token.startsWith('test-user:') ? token.slice(10) : null },
  async listKeys(token) { const sub = token.slice(10); return fakeKeys.filter((k) => k.sub === sub) },
  async revokeKey(token, id) { const k = fakeKeys.find((x) => x.id === id); if (k) k.revoked = true },
  async createKey(token, label) {
    const id = `k${fakeKeys.length + 1}`
    fakeKeys.push({ id, sub: token.slice(10), label, revoked: false })
    return { key: `ra_test_${id}_${'x'.repeat(24)}` }
  },
}

export const testModeEnabled = () => process.env.OAUTH_TEST_MODE === '1' && process.env.NODE_ENV !== 'production'
export const getApproveDeps = (): ApproveDeps => (testModeEnabled() ? testDeps : realDeps)
