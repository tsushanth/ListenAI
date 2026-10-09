import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./adminDashboard.js');
const NOW = new Date('2026-10-08T12:00:00Z');

const user = (id: string, email: string, created = '2026-09-01T00:00:00Z') => ({ id, email, created_at: created });
const key = (u: string, id: string, revoked: string | null = null, created = '2026-09-02T00:00:00Z') =>
  ({ user_id: u, gateway_key_id: id, created_at: created, revoked_at: revoked });
const use = (u: string, day: string, over: Record<string, number> = {}) =>
  ({ day, user_id: u, chars: 0, piper_chars: 0, audio_seconds: 0, free_chars: 0, updated_at: `${day}T10:00:00Z`, ...over });

async function inputs(over: Record<string, unknown> = {}) {
  const { parseExcludeEmails } = await modP;
  return {
    users: [user('a', 'a@example.test'), user('b', 'b@example.test'), user('me', 'ME@example.test'), user('c', 'c@example.test')],
    keys: [key('a', 'k1'), key('a', 'k2', '2026-09-20T00:00:00Z'), key('b', 'k3'), key('me', 'k4')],
    usage: [
      use('a', '2026-10-08', { chars: 1000, piper_chars: 400, audio_seconds: 120 }),
      use('a', '2026-10-07', { chars: 500 }),
      use('b', '2026-10-08', { free_chars: 300 }),
      use('me', '2026-10-08', { chars: 999999 }),
    ],
    credits: [{ user_id: 'a', granted: 1000, used: 400 }, { user_id: 'b', granted: 1000, used: 1000 }, { user_id: 'me', granted: 1, used: 1 }],
    billing: [{ user_id: 'a', active: true }, { user_id: 'me', active: true }],
    stt: [], health: [], now: NOW, range: '7d' as const,
    excluded: parseExcludeEmails(' me@example.test , '),
    ...over,
  } as any;
}

test('parseRange: valid values pass, junk falls back to 7d', async () => {
  const { parseRange } = await modP;
  assert.equal(parseRange('24h'), '24h');
  assert.equal(parseRange('30d'), '30d');
  for (const v of ['999d', '', undefined, ['7d'], 5, null, '7D']) assert.equal(parseRange(v), '7d');
});

test('parseExcludeEmails lower-cases, trims and drops empties', async () => {
  const { parseExcludeEmails } = await modP;
  assert.deepEqual([...parseExcludeEmails(' A@x.test, ,b@X.test')].sort(), ['a@x.test', 'b@x.test']);
  assert.equal(parseExcludeEmails(undefined).size, 0);
});

test('excluded users (case-insensitive) are absent from totals, funnel and customers', async () => {
  const m = await modP; const i = await inputs();
  const t = m.buildTotals(i);
  assert.equal(t.accounts, 2);               // a, b (me excluded; c has no key)
  assert.equal(t.activeKeys, 2);             // k1, k3 (k2 revoked, k4 is mine)
  assert.equal(t.paidCustomers, 1);          // a
  assert.equal(t.kokoroChars + t.piperChars, 1500); // a: 1000 + 500; my 999,999 excluded
  assert.equal(m.buildFunnel(i)[0]!.count, 2);
  assert.ok(!m.buildCustomers(i).some((c: any) => c.userId === 'me'));
});

test('totals: kokoro/piper split, stt minutes, free chars, credits', async () => {
  const m = await modP; const t = m.buildTotals(await inputs());
  assert.equal(t.piperChars, 400);
  assert.equal(t.kokoroChars, 1100);         // (1000-400) + 500
  assert.equal(t.sttMinutes, 2);
  assert.equal(t.freeCharsUsed, 300);
  assert.equal(t.creditsGranted, 2000);
  assert.equal(t.creditsUsed, 1400);
});

test('a comped account is not a paying customer and is shown as comped', async () => {
  const m = await modP;
  const i = await inputs({ billing: [{ user_id: 'a', active: true, comped: true }] });
  assert.equal(m.buildTotals(i).paidCustomers, 0);
  assert.equal(m.buildFunnel(i)[3]!.count, 0);
  assert.equal(m.buildCustomers(i).find((c: any) => c.userId === 'a')!.status, 'comped');
});

test('range 24h only counts usage from the last UTC day', async () => {
  const m = await modP; const t = m.buildTotals(await inputs({ range: '24h' }));
  assert.equal(t.kokoroChars + t.piperChars, 1000);
});

test('funnel stages count accounts that reached each step', async () => {
  const m = await modP; const f = m.buildFunnel(await inputs());
  assert.deepEqual(f.map((s: any) => [s.stage, s.count]), [
    ['Created a key', 2], ['Made a first request', 2], ['Used up free credits', 1], ['Added a card', 1],
  ]);
});

test('customers: status, credits left, usage windows and first/last request', async () => {
  const m = await modP; const cs = m.buildCustomers(await inputs());
  const a = cs.find((c: any) => c.userId === 'a')!, b = cs.find((c: any) => c.userId === 'b')!;
  assert.equal(a.status, 'paid'); assert.equal(a.activeKeys, 1); assert.equal(a.creditsLeft, 600);
  assert.equal(a.chars7d, 1500); assert.equal(a.firstRequest, '2026-10-07'); assert.equal(a.lastRequest, '2026-10-08T10:00:00Z');
  assert.equal(b.status, 'at limit'); assert.equal(b.creditsLeft, 0);
});

test('attention: down/slow workers, at-limit without a card, spikes, STT failures', async () => {
  const m = await modP;
  const usage = [
    ...Array.from({ length: 7 }, (_, d) => use('a', `2026-10-0${1 + d}`, { chars: 10000 })),
    use('a', '2026-10-08', { chars: 600000 }),
  ];
  const stt = Array.from({ length: 3 }, (_, n) => ({ user_id: 'a', status: 'failed', created_at: `2026-10-08T11:${10 + n}:00Z` }));
  const i = await inputs({
    usage, stt,
    health: [{ name: 'piper', status: 'down', checkedAt: NOW.toISOString() }, { name: 'gateway', status: 'slow', latencyMs: 2100, checkedAt: NOW.toISOString() }],
  });
  const att = m.buildAttention(i, m.buildCustomers(i)).map((x: any) => x.text);
  assert.ok(att.includes('piper is down'));
  assert.ok(att.includes('gateway is slow (2100 ms)'));
  assert.ok(att.some((t: string) => t.startsWith('b@example.test is out of free credits')));
  assert.ok(att.some((t: string) => t.startsWith('a@example.test: usage spike')));
  assert.ok(att.includes('Batch STT: 3 failed requests in the last hour'));
});

test('no attention items when everything is healthy', async () => {
  const m = await modP; const i = await inputs({ credits: [], health: [{ name: 'gateway', status: 'up', checkedAt: NOW.toISOString() }] });
  assert.deepEqual(m.buildAttention(i, m.buildCustomers(i)), []);
});

test('series gives one row per UTC day with new accounts, chars and stt minutes', async () => {
  const m = await modP; const s = m.buildSeries(await inputs({ range: '7d' }));
  assert.equal(s.length, 7);
  assert.deepEqual(s[s.length - 1], { day: '2026-10-08', newAccounts: 0, chars: 1000, sttMinutes: 2 });
});

test('fetchAll pages past the 1,000-row server limit and stops on a short page', async () => {
  const { fetchAll } = await modP;
  const total = 2300; const seen: Array<[number, number]> = [];
  const rows = await fetchAll(async (from, to) => {
    seen.push([from, to]);
    return { data: Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ n: from + i })), error: null };
  }, 1000);
  assert.equal(rows.length, 2300);
  assert.deepEqual(seen, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('fetchAll throws on a database error', async () => {
  const { fetchAll } = await modP;
  await assert.rejects(() => fetchAll(async () => ({ data: null, error: { message: 'bad' } })), /bad/);
});

test('section captures a thrown error without throwing', async () => {
  const { section } = await modP;
  assert.deepEqual(await section(async () => 5), { ok: true, data: 5 });
  const bad = await section(async () => { throw new Error('nope'); });
  assert.deepEqual(bad, { ok: false, error: 'nope' });
});

test('excluded user never appears in attention (stt failures, spike, depleted credits) nor newAccounts', async () => {
  const m = await modP;
  const usage = [
    ...Array.from({ length: 7 }, (_, d) => use('me', `2026-10-0${1 + d}`, { chars: 1000 })),
    use('me', '2026-10-08', { chars: 600000 }),
  ];
  const stt = Array.from({ length: 3 }, (_, n) => ({ user_id: 'me', status: 'failed', created_at: `2026-10-08T11:${10 + n}:00Z` }));
  const i = await inputs({
    usage, stt,
    keys: [key('a', 'k1'), key('b', 'k3'), key('me', 'k4', null, '2026-10-07T00:00:00Z')],
    credits: [{ user_id: 'me', granted: 1, used: 1 }],
    billing: [],
  });
  assert.deepEqual(m.buildAttention(i, m.buildCustomers(i)).map((x: any) => x.text).filter((t: string) => /me@|ME@|STT/i.test(t)), []);
  assert.equal(m.buildTotals(i).newAccounts, 0);
  assert.equal(m.buildSeries(i).reduce((s: number, r: any) => s + r.newAccounts, 0), 0);
});

test('STT failures from non-excluded users without a key still count', async () => {
  const m = await modP;
  const stt = Array.from({ length: 3 }, (_, n) => ({ user_id: 'c', status: 'failed', created_at: `2026-10-08T11:${10 + n}:00Z` }));
  const i = await inputs({ stt, credits: [] });
  assert.ok(m.buildAttention(i, m.buildCustomers(i)).some((x: any) => x.text === 'Batch STT: 3 failed requests in the last hour'));
});

test('duplicate billing rows do not double count paid customers', async () => {
  const m = await modP;
  const i = await inputs({ billing: [{ user_id: 'a', active: true }, { user_id: 'a', active: true }] });
  assert.equal(m.buildTotals(i).paidCustomers, 1);
  assert.equal(m.buildFunnel(i)[3]!.count, 1);
});

test('section survives a thrown null', async () => {
  const { section } = await modP;
  const r = await section(async () => { throw null; });
  assert.equal(r.ok, false);
});
