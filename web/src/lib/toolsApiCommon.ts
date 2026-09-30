import { supabase } from './supabaseClient'

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

/** Error carrying the HTTP status and backend error code so pages can branch on 402 etc. */
export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
  /** 402 that means "no active subscription" (as opposed to a quota being used up). */
  get subscriptionRequired(): boolean {
    return this.status === 402 && this.code !== 'QUOTA_EXCEEDED'
  }
  get quotaExceeded(): boolean {
    return this.status === 402 && this.code === 'QUOTA_EXCEEDED'
  }
}

export async function token(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const t = data.session?.access_token
  if (!t) throw new Error('Please sign in again.')
  return t
}

export async function authHeaders(json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await token()}` }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

/**
 * Turn a failed response into an ApiError. Backend routes answer either
 * `{ error: "text" }` (stt, voice-isolate) or `{ error: "CODE", message: "text" }`
 * (routes behind errorHandler: dub, sound-effects, audiobooks).
 */
export async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  const error = typeof body?.error === 'string' ? body.error : ''
  const message = typeof body?.message === 'string' ? body.message : ''
  const code = message ? error : ''
  let text = message || error
  if (res.status === 404 && (!text || text === 'Not found')) {
    text = 'This tool is not enabled on the server yet.'
  } else if (res.status === 402 && !text) {
    text = 'Your free credits are used up, or this feature needs an active subscription.'
  }
  throw new ApiError(res.status, text || `Something went wrong (HTTP ${res.status}).`, code)
}

/** Poll `fn` until it returns a non-undefined value, `isCancelled()` is true, or `maxMs` elapses. */
export async function pollUntil<T>(
  fn: () => Promise<T | undefined>,
  opts: { intervalMs: number; maxMs: number; isCancelled: () => boolean },
): Promise<T | undefined> {
  const started = Date.now()
  while (!opts.isCancelled() && Date.now() - started < opts.maxMs) {
    await new Promise((r) => setTimeout(r, opts.intervalMs))
    if (opts.isCancelled()) return undefined
    try {
      const v = await fn()
      if (v !== undefined) return v
    } catch (e) {
      // A definitive client error (404 job lost, 401, 402...) ends polling; network blips do not.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) throw e
    }
  }
  return undefined
}

/**
 * Turn a (possibly cross-origin, signed) audio URL into a same-origin blob URL so the
 * `download` attribute works. Falls back to the original URL if the fetch is blocked (CORS).
 */
export async function toObjectUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url)
    if (!res.ok) return url
    return URL.createObjectURL(await res.blob())
  } catch {
    return url
  }
}
