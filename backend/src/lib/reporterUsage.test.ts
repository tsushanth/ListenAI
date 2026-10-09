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

const NOW = new Date('2026-10-09T10:00:00Z');
const row = (day: string, chars: number) => ({ day, user_id: 'u1', chars, piper_chars: 0, audio_seconds: 0, free_chars: 0, updated_at: `${day}T00:00:00Z` });

function fakeBase(asked: string[], networkCalls: string[]): any {
  const all = [row('2026-10-09', 100), row('2026-10-08', 7000)];
  return {
    now: () => NOW,
    listUsers: async () => [{ id: 'u1', email: 'a@example.test', created_at: '2026-10-01T00:00:00Z' }],
    listKeys: async () => [{ user_id: 'u1', gateway_key_id: 'k1', created_at: '2026-10-01T00:00:00Z', revoked_at: null }], listFreeCredits: async () => [], listBilling: async () => [],
    // Honors sinceDay like the real query, so the test proves what window the push asks for.
    listUsage: async (since: string) => { asked.push(since); return all.filter((r) => r.day >= since); },
    listRecentStt: async () => { networkCalls.push('stt'); return []; },
    listEvents: async () => { networkCalls.push('events'); return []; },
    firstUsageDay: async () => { networkCalls.push('first'); return null; },
    startProbes: async () => { networkCalls.push('probe'); return []; },
    probes: async () => { networkCalls.push('probes'); return []; },
  };
}

test('push deps: no probes, no extra queries, usage window is today (UTC) only', async () => {
  const { makePushDashboardDeps } = await modP;
  const { buildDashboard } = await import('./adminDashboard.js');
  const asked: string[] = [], calls: string[] = [];
  const deps = makePushDashboardDeps(fakeBase(asked, calls), () => NOW);
  assert.equal(deps.startProbes, undefined);
  assert.deepEqual(await deps.probes([], []), []);
  const d = await buildDashboard(deps, { range: '24h', excludeEmails: new Set() });
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, ['2026-10-09']);
  assert.ok(d.totals.ok);
  assert.equal((d.totals as any).data.kokoroChars, 100); // yesterday's 7000 is not counted
});

test('totals window is pinned to the clock: only today counts for 24h even when yesterday rows are present', async () => {
  const { buildDashboard } = await import('./adminDashboard.js');
  const asked: string[] = [];
  const d = await buildDashboard(fakeBase(asked, []), { range: '24h', excludeEmails: new Set() });
  assert.ok(d.totals.ok);
  assert.equal((d.totals as any).data.kokoroChars, 100);
});

test('usageUrlFrom derives /v1/usage and never returns the report endpoint', async () => {
  const { usageUrlFrom } = await modP;
  assert.equal(usageUrlFrom('https://w.example/v1/report'), 'https://w.example/v1/usage');
  assert.equal(usageUrlFrom('https://w.example/v1/report/'), 'https://w.example/v1/usage');
  assert.equal(usageUrlFrom('https://w.example/other'), 'https://app-failure-reporter.t-sushanth.workers.dev/v1/usage');
  assert.equal(usageUrlFrom(undefined), 'https://app-failure-reporter.t-sushanth.workers.dev/v1/usage');
});
