// Tester bypass for POST /api/realtime-tts/authorize (owner decision 2026-11-20: debug/test builds and our own probes must
// not be stopped by the anonymous per-IP quota and rate limits).
//
// HOW IT WORKS
//   A request carrying header X-Tts-Test-Key whose value equals the Fly secret TTS_TEST_BYPASS_KEY skips, for that one request,
//   every limiter on the authorize path: the express limiters (standard 60/min, burst 3/10 s, authorize 10 or 60 per 5 min)
//   and the TtsQuota checks (per minute, daily budget, global breaker, new-id cap).
//   SECRET UNSET (or shorter than 16 characters) = feature fully off; the header is ignored.
//   The comparison is constant time (sha256 of both sides, then crypto.timingSafeEqual on the equal-length digests), so neither
//   the value nor its length leaks through timing.
//
// WHAT THIS DOES NOT DO
//   It does not change what the request costs: a bypassed authorize still mints a real session against the shared platform key.
//   It is for testing, not a general-purpose key. Ship it only in debug/test builds of the app.
//
// LOGGING
//   One line: "test-bypass used". Never the key, the IP, an install id, or the header value.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const MIN_SECRET_LENGTH = 16;
const AUTHORIZE_PATH = '/api/realtime-tts/authorize';

/** Constant-time string equality: compares sha256 digests (always 32 bytes) with timingSafeEqual. */
export function safeEqualSecret(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** True only for POST /api/realtime-tts/authorize with a header equal to the configured secret. */
export function isTtsTestBypass(
  req: Pick<Request, 'method' | 'originalUrl' | 'headers'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const secret = env.TTS_TEST_BYPASS_KEY;
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return false; // unset = off
  if (req.method !== 'POST') return false;
  const path = (req.originalUrl ?? '').split('?')[0]!.replace(/\/+$/, '');
  if (path !== AUTHORIZE_PATH) return false;
  const header = req.headers['x-tts-test-key'];
  if (typeof header !== 'string' || header.length === 0) return false; // absent or repeated header
  return safeEqualSecret(header, secret);
}

export function logTestBypassUsed(): void {
  console.log(JSON.stringify({ event: 'tts_test_bypass', message: 'test-bypass used' }));
}
