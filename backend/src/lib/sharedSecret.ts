import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * Constant-time comparison of a caller-supplied credential against the configured shared secret.
 * Fails closed: an unset/empty secret, or a non-string/empty credential, never matches (so an
 * absent env var can never turn "undefined === undefined" into a pass).
 */
export function secretMatches(given: unknown, expected: string | undefined | null): boolean {
  if (!expected || typeof given !== 'string' || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}
