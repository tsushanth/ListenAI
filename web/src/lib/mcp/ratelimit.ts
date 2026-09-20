// Minimal in-memory sliding-window limiter. Per server instance only (not shared across Fly machines).
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>()
  private limit: number
  private windowMs: number
  private maxKeys: number
  constructor(limit: number, windowMs: number, maxKeys = 10_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  check(key: string, now = Date.now()): { ok: boolean; retryAfterSec: number } {
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) }
    }
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > this.maxKeys) this.prune(now)
    return { ok: true, retryAfterSec: 0 }
  }

  private prune(now: number) {
    this.hits.forEach((v, k) => { if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k) })
    if (this.hits.size > this.maxKeys) this.hits.clear() // last resort so memory stays bounded
  }
}
