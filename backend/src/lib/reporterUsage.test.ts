import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./reporterUsage.js');
const totals = { accounts: 2, activeKeys: 2, newAccounts: 1, kokoroChars: 1200, piperChars: 300, sttMinutes: 12.345, freeCharsUsed: 50, creditsGranted: 20000, creditsUsed: 50, paidCustomers: 1, billedUnits: 900 } as any;

test('headlineMetrics names and rounds the daily headline numbers', async () => {
  const { headlineMetrics } = await modP;
  const m = Object.fromEntries(headlineMetrics(totals).map((x: any) => [x.metric, x.value]));
  assert.deepEqual(m, {
    'api.accounts': 2, 'api.new_accounts': 1, 'api.kokoro_chars': 1200, 'api.piper_chars': 300,
    'api.free_chars': 50, 'api.stt_minutes': 12.3, 'api.paid_customers': 1,
  });
});

test('every metric name is valid for the Worker (charset and length)', async () => {
  const { headlineMetrics } = await modP;
  for (const x of headlineMetrics(totals)) { assert.match(x.metric, /^[a-z0-9_.-]+$/i); assert.ok(x.metric.length <= 60); }
});

test('push posts today (UTC) once with all metrics', async () => {
  const { pushHeadlineMetrics } = await modP;
  const calls: any[] = [];
  const r = await pushHeadlineMetrics({ totals: async () => totals, post: async (day, items) => { calls.push({ day, n: items.length }); }, now: () => new Date('2026-10-09T23:59:00Z') });
  assert.deepEqual(calls, [{ day: '2026-10-09', n: 7 }]);
  assert.equal(r.pushed, 7);
});

test('no totals (section failed) pushes nothing, so zeros never overwrite real values', async () => {
  const { pushHeadlineMetrics } = await modP;
  let posted = false;
  const r = await pushHeadlineMetrics({ totals: async () => null, post: async () => { posted = true; }, now: () => new Date() });
  assert.equal(posted, false);
  assert.equal(r.pushed, 0);
});

test('a throwing post or totals never propagates', async () => {
  const { pushHeadlineMetrics } = await modP;
  await pushHeadlineMetrics({ totals: async () => totals, post: async () => { throw new Error('worker down'); }, now: () => new Date() });
  await pushHeadlineMetrics({ totals: async () => { throw new Error('db down'); }, post: async () => {}, now: () => new Date() });
});
