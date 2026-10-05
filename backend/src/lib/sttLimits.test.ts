// npm test (node:test via tsx). Unit tests for the in-memory per-key rate + concurrency limiter
// used by the STT routes (lib/sttLimits.ts). Time is injected, nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SttLimiter } from './sttLimits.js';

const base = { ratePerMin: 3, maxConcurrentPerKey: 2, maxConcurrentGlobal: 3, concurrencyRetryAfterSec: 5 };

test('sliding-window rate limit with accurate Retry-After', () => {
  let t = 1_000_000;
  const l = new SttLimiter(base, () => t);
  for (let i = 0; i < 3; i++) { t += 1000; assert.equal(l.checkRate('k').ok, true); }
  const r = l.checkRate('k');
  assert.equal(r.ok, false);
  // oldest hit was 2 s ago: it leaves the 60 s window in 58 s
  assert.equal(r.ok === false && r.retryAfterSec, 58);
  t += 58_001;
  assert.equal(l.checkRate('k').ok, true);
});

test('keys are independent; per-key override beats the default', () => {
  const t = 5_000;
  const l = new SttLimiter(base, () => t);
  for (let i = 0; i < 3; i++) l.checkRate('a');
  assert.equal(l.checkRate('a').ok, false);
  assert.equal(l.checkRate('b').ok, true);
  assert.equal(l.checkRate('c', { ratePerMin: 1 }).ok, true);
  assert.equal(l.checkRate('c', { ratePerMin: 1 }).ok, false);
});

test('concurrency: per-key and global caps, release is idempotent', () => {
  const l = new SttLimiter(base, () => 0);
  const a1 = l.acquire('a'); const a2 = l.acquire('a');
  assert.ok(a1.ok && a2.ok);
  const a3 = l.acquire('a');
  assert.equal(a3.ok, false);
  assert.equal(a3.ok === false && a3.retryAfterSec, 5);
  const b1 = l.acquire('b');
  assert.ok(b1.ok);
  assert.equal(l.acquire('c').ok, false, 'global cap of 3 reached');
  if (a1.ok) { a1.release(); a1.release(); }
  assert.equal(l.inFlight('a'), 1);
  assert.equal(l.inFlightTotal(), 2);
  assert.equal(l.acquire('c').ok, true);
});

test('idle keys are pruned so the maps do not grow without bound', () => {
  let t = 0;
  const l = new SttLimiter(base, () => t);
  for (let i = 0; i < 50; i++) l.checkRate(`k${i}`);
  t += 120_000;
  l.prune();
  assert.equal(l.trackedKeys(), 0);
});
