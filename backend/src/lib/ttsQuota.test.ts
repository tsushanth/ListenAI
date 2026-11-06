import test from 'node:test';
import assert from 'node:assert/strict';
import { TtsQuota, parseInstallId, readQuotaConfig, type Admission, type Rejection } from './ttsQuota.js';

const A = '0b6f2c7e-4a51-4d0e-9a3b-6f1d2c3e4a5b';
const B = '9c1d7a22-1f0e-4b7c-8d55-aa10b2c3d4e5';
const T0 = Date.UTC(2026, 10, 6, 10, 0, 0);

function mk(env: NodeJS.ProcessEnv = {}, start = T0) {
  const clock = { t: start };
  const lines: Record<string, unknown>[] = [];
  const q = new TtsQuota({ env, now: () => clock.t, log: (l) => lines.push(l) });
  return { q, clock, lines };
}
const ok = (r: Admission | Rejection): Admission => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Admission; };
const no = (r: Admission | Rejection): Rejection => { assert.equal(r.ok, false); return r as Rejection; };

test('parseInstallId: accepts a UUID, rejects absent/garbled/nil/repeated', () => {
  assert.equal(parseInstallId(A.toUpperCase()), A);
  assert.equal(parseInstallId(` ${A} `), A);
  for (const v of [undefined, '', 'abc', A + 'x', '00000000-0000-0000-0000-000000000000', [A, B], `${A}, ${B}`]) {
    assert.equal(parseInstallId(v as string), null, String(v));
  }
});

test('readQuotaConfig: defaults, and garbled/negative/decimal values fall back', () => {
  const d = readQuotaConfig({});
  assert.equal(d.userDailyChars, 200_000);
  assert.equal(d.globalDailyChars, 20_000_000);
  assert.equal(d.authorizeCharsEstimate, 4000);
  const g = readQuotaConfig({ TTS_USER_DAILY_CHARS: '-5', TTS_GLOBAL_DAILY_CHARS: 'abc', TTS_AUTHORIZE_CHARS_ESTIMATE: '0', TTS_USER_AUTHORIZE_PER_MIN: '1.5' });
  assert.equal(g.userDailyChars, 200_000);
  assert.equal(g.globalDailyChars, 20_000_000);
  assert.equal(g.authorizeCharsEstimate, 4000);
  assert.equal(g.userPerMinute, 10);
  assert.equal(readQuotaConfig({ TTS_GLOBAL_DAILY_CHARS: '0' }).globalDailyChars, 0);
});

test('no header: anonymous bucket keyed by IP, stricter per-minute than identified', () => {
  const { q } = mk({ TTS_ANON_AUTHORIZE_PER_MIN: '2', TTS_USER_AUTHORIZE_PER_MIN: '5' });
  assert.equal(ok(q.admit(undefined, '1.1.1.1')).anonymous, true);
  ok(q.admit(undefined, '1.1.1.1'));
  assert.equal(no(q.admit(undefined, '1.1.1.1')).status, 429);
  ok(q.admit(undefined, '2.2.2.2')); // other IP, own bucket
  // identified from the same IP is its own, looser bucket
  for (let i = 0; i < 5; i++) assert.equal(ok(q.admit(A, '1.1.1.1')).anonymous, false);
  assert.equal(no(q.admit(A, '1.1.1.1')).status, 429);
});

test('bad header behaves exactly like no header', () => {
  const { q } = mk({ TTS_ANON_AUTHORIZE_PER_MIN: '1' });
  ok(q.admit('garbage', '1.1.1.1'));
  assert.equal(no(q.admit(undefined, '1.1.1.1')).status, 429);
});

test('per-minute: 429 with Retry-After that counts down, then the window resets', () => {
  const { q, clock } = mk({ TTS_USER_AUTHORIZE_PER_MIN: '1' });
  ok(q.admit(A, 'ip'));
  clock.t += 20_000;
  const r = no(q.admit(A, 'ip'));
  assert.equal(r.status, 429);
  assert.equal(r.reason, 'rate_per_minute');
  assert.equal(r.retryAfterSeconds, 40);
  clock.t += 40_000;
  ok(q.admit(A, 'ip'));
});

test('daily budget: 402 once used >= budget, per identity, reset at 00:00 UTC; rejected requests are not charged', () => {
  const { q, clock } = mk({ TTS_USER_DAILY_CHARS: '8000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000', TTS_USER_AUTHORIZE_PER_MIN: '100' }, Date.UTC(2026, 10, 6, 23, 0, 0));
  ok(q.admit(A, 'ip'));
  ok(q.admit(A, 'ip'));
  const r = no(q.admit(A, 'ip'));
  assert.equal(r.status, 402);
  assert.equal(r.reason, 'daily_budget');
  assert.equal(r.retryAfterSeconds, undefined);
  ok(q.admit(B, 'ip')); // another identity still has budget
  clock.t = Date.UTC(2026, 10, 7, 0, 0, 1);
  ok(q.admit(A, 'ip')); // new UTC day
});

test('global breaker: 503 for everyone once the day total reaches the limit; Retry-After capped at 1h', () => {
  const { q } = mk({ TTS_GLOBAL_DAILY_CHARS: '8000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000' });
  ok(q.admit(A, 'ip'));
  ok(q.admit(B, 'ip'));
  const r = no(q.admit('5d3f2c7e-4a51-4d0e-9a3b-6f1d2c3e4a5b', 'ip'));
  assert.equal(r.status, 503);
  assert.equal(r.reason, 'global_breaker');
  assert.ok(r.retryAfterSeconds! >= 1 && r.retryAfterSeconds! <= 3600);
  assert.equal(no(q.admit(undefined, 'other')).status, 503);
});

test('global limit 0 = kill switch', () => {
  const { q } = mk({ TTS_GLOBAL_DAILY_CHARS: '0' });
  assert.equal(no(q.admit(A, 'ip')).status, 503);
});

test('refund returns the reservation to bucket and global totals', () => {
  const { q } = mk({ TTS_USER_DAILY_CHARS: '4000', TTS_GLOBAL_DAILY_CHARS: '4000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000', TTS_USER_AUTHORIZE_PER_MIN: '100' });
  const a = ok(q.admit(A, 'ip'));
  q.refund(a);
  ok(q.admit(A, 'ip'));
});

test('fresh install ids from one IP: beyond the hourly cap they are demoted to the IP anonymous bucket', () => {
  const { q, clock } = mk({ TTS_NEW_IDS_PER_IP_PER_HOUR: '2', TTS_ANON_AUTHORIZE_PER_MIN: '1' });
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  assert.equal(ok(q.admit(id(1), 'ip')).anonymous, false);
  assert.equal(ok(q.admit(id(2), 'ip')).anonymous, false);
  assert.equal(ok(q.admit(id(3), 'ip')).anonymous, true); // demoted: uses the anonymous IP bucket
  assert.equal(no(q.admit(id(4), 'ip')).status, 429); // the IP bucket allows 1/min, so churning ids does not help
  assert.equal(ok(q.admit(id(1), 'ip')).anonymous, false); // an already-known id is not affected
  clock.t += 3_600_000;
  assert.equal(ok(q.admit(id(5), 'ip')).anonymous, false); // next hour: cap resets
});

test('tracking cap: when the table is full new buckets share one anonymous overflow bucket', () => {
  const { q } = mk({ TTS_QUOTA_MAX_TRACKED: '100', TTS_ANON_AUTHORIZE_PER_MIN: '1000', TTS_NEW_IDS_PER_IP_PER_HOUR: '100000' });
  for (let i = 0; i < 100; i++) ok(q.admit(undefined, `10.0.0.${i}`));
  const over = ok(q.admit(undefined, '10.9.9.9'));
  assert.equal(over.bucket, 'overflow');
  assert.equal(over.anonymous, true);
});

test('telemetry: hourly and daily summaries carry totals, no raw ids, no IPs', () => {
  const { q, clock, lines } = mk({ TTS_USER_AUTHORIZE_PER_MIN: '1', TTS_AUTHORIZE_CHARS_ESTIMATE: '1000' }, Date.UTC(2026, 10, 6, 23, 30, 0));
  ok(q.admit(A, '203.0.113.9'));
  no(q.admit(A, '203.0.113.9')); // per-minute rejection
  ok(q.admit(B, '203.0.113.9'));
  ok(q.admit(undefined, '198.51.100.7'));
  clock.t = Date.UTC(2026, 10, 7, 0, 0, 5);
  q.roll();
  const hour = lines.find((l) => l.window === 'hour')!;
  const day = lines.find((l) => l.window === 'day')!;
  assert.ok(hour && day);
  assert.equal(hour.event, 'tts_authorize_cost');
  assert.equal(hour.estimatedChars, 3000);
  assert.equal(hour.authorizes, 3);
  assert.equal(hour.anonymousAuthorizes, 1);
  assert.equal(hour.distinctBuckets, 3);
  assert.deepEqual(hour.rejections, { global_breaker: 0, rate_per_minute: 1, daily_budget: 0 });
  assert.equal(day.authorizes, 3);
  assert.equal((day.topBuckets as unknown[]).length, 3);
  const dump = JSON.stringify(lines);
  for (const secret of [A, B, '203.0.113.9', '198.51.100.7']) assert.ok(!dump.includes(secret), `leaked ${secret}`);
  // counters restart for the new window
  q.roll();
  clock.t += 3_600_000;
  q.roll();
  assert.equal(lines.filter((l) => l.window === 'hour').length, 1); // empty windows are not logged
});
