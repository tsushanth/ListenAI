// In-memory per-key request-rate and concurrency limiter for the STT routes.
//
// Replaces the old flat "20 transcriptions/hour per user". Two independent controls:
//   - rate: sliding window of `ratePerMin` requests per 60 s per key;
//   - concurrency: at most `maxConcurrentPerKey` requests in flight per key and `maxConcurrentGlobal`
//     overall (the worker has its own container cap, and every in-flight upload occupies temp disk here).
// A "key" is the gateway key id when the identity came from a gateway-forwarded API key, otherwise the user id
// (see subjectOf in routes/stt.ts). Per-key overrides come from the stt_key_settings table.
//
// State is per process: with N backend instances the effective limits are N times larger. That is acceptable
// as abuse/cost protection (the worker and Stripe are the real ceilings) and is documented as a gap; move it
// to Redis/Postgres if exact global enforcement is ever needed.

const WINDOW_MS = 60_000;

export interface SttLimiterConfig {
  ratePerMin: number;
  maxConcurrentPerKey: number;
  maxConcurrentGlobal: number;
  concurrencyRetryAfterSec: number;
}
export interface KeyOverrides { ratePerMin?: number | null; maxConcurrent?: number | null }

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number };
export type AcquireResult = { ok: true; release: () => void } | { ok: false; retryAfterSec: number; scope: 'key' | 'global' };

export class SttLimiter {
  private hits = new Map<string, number[]>();
  private active = new Map<string, number>();
  private total = 0;

  constructor(private cfg: SttLimiterConfig, private now: () => number = Date.now) {}

  checkRate(key: string, o: KeyOverrides = {}): RateResult {
    const limit = o.ratePerMin && o.ratePerMin > 0 ? o.ratePerMin : this.cfg.ratePerMin;
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      const oldest = arr[arr.length - limit] ?? arr[0] ?? t;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.prune();
    return { ok: true };
  }

  acquire(key: string, o: KeyOverrides = {}): AcquireResult {
    const perKey = o.maxConcurrent && o.maxConcurrent > 0 ? o.maxConcurrent : this.cfg.maxConcurrentPerKey;
    const mine = this.active.get(key) ?? 0;
    if (mine >= perKey) return { ok: false, retryAfterSec: this.cfg.concurrencyRetryAfterSec, scope: 'key' };
    if (this.total >= this.cfg.maxConcurrentGlobal) return { ok: false, retryAfterSec: this.cfg.concurrencyRetryAfterSec, scope: 'global' };
    this.active.set(key, mine + 1);
    this.total += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const n = (this.active.get(key) ?? 1) - 1;
        if (n <= 0) this.active.delete(key); else this.active.set(key, n);
        this.total = Math.max(0, this.total - 1);
      },
    };
  }

  inFlight(key: string): number { return this.active.get(key) ?? 0; }
  inFlightTotal(): number { return this.total; }
  trackedKeys(): number { return this.hits.size + this.active.size; }

  /** Drop keys whose whole window has expired (and have nothing in flight). */
  prune(): void {
    const t = this.now();
    for (const [k, arr] of this.hits) {
      if (!arr.some((x) => t - x < WINDOW_MS)) this.hits.delete(k);
    }
  }
}
