// backend/scripts/request-log-report.test.mjs
// Run: npm test. Logic of the read-only report on fixture data; never touches a database or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, median, parseArgs, formatReport, fetchInputs, DEFAULT_DAYS } from './request-log-report.mjs';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const day = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const users = [
  { id: 'u-new', email: 'new@example.test', created_at: day(5) },
  { id: 'u-quiet', email: 'quiet@example.test', created_at: day(20) },
  { id: 'u-old', email: 'old@example.test', created_at: day(90) }, // outside the 60-day window
  { id: 'u-edge', email: 'edge@example.test', created_at: day(59) },
];
const keys = [
  { user_id: 'u-new', gateway_key_id: 'k-new-1' },
  { user_id: 'u-new', gateway_key_id: 'k-new-2' }, // an account can hold several keys
  { user_id: 'u-old', gateway_key_id: 'k-old' },
  { user_id: 'u-edge', gateway_key_id: 'k-edge' },
];
const rows = [
  { gateway_key_id: 'k-new-1', ts: day(4), outcome: 'auth_failed', ttfb_ms: null, error_code: 'invalid_key' },
  { gateway_key_id: 'k-new-1', ts: day(3), outcome: 'ok', ttfb_ms: 100, error_code: null },
  { gateway_key_id: 'k-new-2', ts: day(2), outcome: 'ok', ttfb_ms: 300, error_code: null },
  { gateway_key_id: 'k-new-2', ts: day(1), outcome: 'quota_exceeded', ttfb_ms: null, error_code: 'quota_exceeded' },
  { gateway_key_id: 'k-new-2', ts: day(0.5), outcome: 'client_error', ttfb_ms: 50, error_code: 'bad_voice' },
  { gateway_key_id: 'k-new-2', ts: day(0.4), outcome: 'client_error', ttfb_ms: 70, error_code: 'bad_voice' },
  { gateway_key_id: 'k-old', ts: day(1), outcome: 'ok', ttfb_ms: 10, error_code: null },
  { gateway_key_id: 'k-deleted', ts: day(1), outcome: 'ok', ttfb_ms: 10, error_code: null }, // key row gone: belongs to nobody
];

test('only accounts created within the window are reported; newest account first', () => {
  const r = buildReport({ users, keys, rows, days: 60, now: NOW });
  assert.deepEqual(r.map((a) => a.email), ['new@example.test', 'quiet@example.test', 'edge@example.test']);
  assert.equal(buildReport({ users, keys, rows, days: 10, now: NOW }).length, 1);
  assert.equal(buildReport({ users, keys, rows, days: 100, now: NOW }).length, 4);
});

test('per account: first call, count, success rate, outcome counts, median ttfb across all of its keys', () => {
  const a = buildReport({ users, keys, rows, days: 60, now: NOW }).find((x) => x.email === 'new@example.test');
  assert.equal(a.calls, 6);
  assert.equal(a.first_call_at, day(4));
  assert.equal(a.success_rate, 2 / 6);
  assert.deepEqual(a.by_outcome, { auth_failed: 1, ok: 2, quota_exceeded: 1, client_error: 2 });
  assert.equal(a.median_ttfb_ms, 85); // ttfb present on 100,300,50,70 -> sorted 50,70,100,300 -> (70+100)/2
});

test('last error codes: distinct, most recent first, capped at 5, nulls skipped', () => {
  const a = buildReport({ users, keys, rows, days: 60, now: NOW }).find((x) => x.email === 'new@example.test');
  assert.deepEqual(a.last_error_codes, ['bad_voice', 'quota_exceeded', 'invalid_key']);
  const many = Array.from({ length: 9 }, (_, i) => ({ gateway_key_id: 'k-edge', ts: day(9 - i), outcome: 'server_error', ttfb_ms: null, error_code: `e${i}` }));
  const e = buildReport({ users, keys, rows: many, days: 60, now: NOW }).find((x) => x.email === 'edge@example.test');
  assert.deepEqual(e.last_error_codes, ['e8', 'e7', 'e6', 'e5', 'e4']);
  assert.equal(e.median_ttfb_ms, null, 'no ttfb on any row');
});

test('an account with no key or no calls is listed with calls 0, null rates, never dividing by zero', () => {
  const q = buildReport({ users, keys, rows, days: 60, now: NOW }).find((x) => x.email === 'quiet@example.test');
  assert.deepEqual({ ...q, account_created_at: undefined }, {
    email: 'quiet@example.test', account_created_at: undefined, first_call_at: null, calls: 0, success_rate: null,
    by_outcome: {}, median_ttfb_ms: null, last_error_codes: [],
  });
});

test('rows are matched by gateway_key_id only; orphan key ids and other accounts do not leak in', () => {
  const r = buildReport({ users, keys, rows, days: 100, now: NOW });
  assert.equal(r.find((x) => x.email === 'old@example.test').calls, 1);
  assert.equal(r.reduce((n, a) => n + a.calls, 0), 7, 'the orphan k-deleted row is counted for nobody');
});

test('rows given out of order still give the true first call and latest errors', () => {
  const shuffled = [...rows].reverse();
  const a = buildReport({ users, keys, rows: shuffled, days: 60, now: NOW }).find((x) => x.email === 'new@example.test');
  assert.equal(a.first_call_at, day(4));
  assert.deepEqual(a.last_error_codes, ['bad_voice', 'quota_exceeded', 'invalid_key']);
});

test('median matches percentile_cont(0.5): odd, even, empty, ignores null', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([null, undefined, 7]), 7);
});

test('parseArgs: default 60, numeric days, --json, rejects junk', () => {
  assert.deepEqual(parseArgs([]), { days: DEFAULT_DAYS, json: false });
  assert.deepEqual(parseArgs(['30', '--json']), { days: 30, json: true });
  for (const bad of [['0'], ['-5'], ['abc'], ['1.5'], ['5000'], ['--write']]) assert.ok('error' in parseArgs(bad), bad.join(' '));
});

test('formatReport prints each account and the empty case', () => {
  const text = formatReport(buildReport({ users, keys, rows, days: 60, now: NOW }), 60);
  assert.match(text, /new@example\.test/);
  assert.match(text, /calls 6  success 33\.3%/);
  assert.match(text, /median ttfb 85 ms/);
  assert.match(text, /calls 0  success n\/a/);
  assert.match(formatReport([], 60), /No accounts created/);
});

test('fetchInputs issues GET requests only, scoped to the window and the accounts found', async () => {
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    if (path.startsWith('/auth/v1/admin/users')) return { users };
    if (path.startsWith('/rest/v1/realtimetts_api_keys')) return keys.filter((k) => k.user_id !== 'u-old');
    if (path.startsWith('/rest/v1/realtimetts_request_log')) return rows;
    throw new Error(`unexpected ${path}`);
  };
  const r = await fetchInputs({ get, days: 60, now: NOW });
  assert.deepEqual(r.users.map((u) => u.id).sort(), ['u-edge', 'u-new', 'u-quiet']);
  assert.ok(seen.every((p) => p.startsWith('/auth/v1/admin/users') || p.startsWith('/rest/v1/realtimetts_')));
  assert.ok(seen.some((p) => p.includes('realtimetts_request_log') && p.includes('gateway_key_id=in.')));
});

test('the script source contains no write verbs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./request-log-report.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /method:\s*'(POST|PUT|PATCH|DELETE)'/i);
  assert.match(src, /method: 'GET'/);
  assert.doesNotMatch(src, /\.(insert|update|upsert|delete)\(/);
});
