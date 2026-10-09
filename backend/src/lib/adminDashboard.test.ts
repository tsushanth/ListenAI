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

test('buildDashboard returns every section and labels usage history start', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    firstUsageDay: async () => '2026-10-07',
    probes: async () => [{ name: 'gateway', status: 'up', latencyMs: 40, checkedAt: NOW.toISOString() }],
  };
  const r = await m.buildDashboard(deps as any, { range: '7d', excludeEmails: base.excluded });
  for (const k of ['attention', 'health', 'totals', 'funnel', 'customers', 'series']) assert.equal((r as any)[k].ok, true, k);
  assert.equal(r.usageSince, '2026-10-07');
  assert.equal((r.totals as any).data.accounts, 2);
});

test('one failing source blanks only the sections that need it', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys,
    listUsage: async () => { throw new Error('usage table missing'); },
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    firstUsageDay: async () => '2026-10-07',
    probes: async () => [],
  };
  const r = await m.buildDashboard(deps as any, { range: '7d', excludeEmails: base.excluded });
  assert.equal(r.totals.ok, false);
  assert.match((r.totals as any).error, /usage table missing/);
  assert.equal(r.health.ok, true);       // health does not depend on the usage table
});

test('a failing probe set does not take down the other sections', async () => {
  const m = await modP; const base = await inputs();
  const deps = {
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    firstUsageDay: async () => '2026-10-07',
    probes: async () => { throw new Error('probe boom'); },
  };
  const r = await m.buildDashboard(deps as any, { range: '24h', excludeEmails: base.excluded });
  assert.equal(r.health.ok, false);
  assert.equal(r.customers.ok, true);
  assert.equal(r.totals.ok, true);
});

test('attention flags failed STT and health sources instead of looking clean', async () => {
  const m = await modP; const base = await inputs();
  const mk = (over: any) => ({
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    firstUsageDay: async () => '2026-10-07', probes: async () => [], ...over,
  });
  const a = await m.buildDashboard(mk({ listRecentStt: async () => { throw new Error('stt down'); } }) as any, { range: '7d', excludeEmails: base.excluded });
  assert.equal(a.attention.ok, true);
  assert.ok((a.attention as any).data.some((x: any) => x.level === 'warn' && x.text === 'Could not check batch STT failures: stt down'));
  assert.equal(a.totals.ok, true); assert.equal(a.customers.ok, true);
  const b = await m.buildDashboard(mk({ probes: async () => { throw new Error('probe boom'); } }) as any, { range: '7d', excludeEmails: base.excluded });
  assert.ok((b.attention as any).data.some((x: any) => x.text === 'Could not check worker health: probe boom'));
});

test('usageSince comes from firstUsageDay, and its failure only nulls usageSince', async () => {
  const m = await modP; const base = await inputs();
  const mk = (first: () => Promise<string | null>) => ({
    now: () => NOW, listUsers: async () => base.users, listKeys: async () => base.keys, listUsage: async () => base.usage,
    listFreeCredits: async () => base.credits, listBilling: async () => base.billing, listRecentStt: async () => [],
    firstUsageDay: first, probes: async () => [],
  });
  const a = await m.buildDashboard(mk(async () => '2026-08-01') as any, { range: '7d', excludeEmails: base.excluded });
  assert.equal(a.usageSince, '2026-08-01');
  const b = await m.buildDashboard(mk(async () => { throw new Error('nope'); }) as any, { range: '7d', excludeEmails: base.excluded });
  assert.equal(b.usageSince, null);
  for (const k of ['attention', 'health', 'totals', 'funnel', 'customers', 'series']) assert.equal((b as any)[k].ok, true, k);
});

test('default deps page with stable tiebreaker ordering', async () => {
  const m = await modP;
  const { supabase } = await import('./supabaseClient.js');
  const sb = supabase as any;
  const orig = sb.from;
  const calls: Record<string, string[]> = {};
  sb.from = (table: string) => {
    const log = (calls[table] ??= []);
    const q: any = {
      select: () => q, gte: () => q,
      order: (c: string) => { log.push(`order:${c}`); return q; },
      range: (f: number, t: number) => {
        log.push(`range:${f}-${t}`);
        const n = f === 0 ? 1000 : 5;
        return Promise.resolve({ data: Array.from({ length: n }, (_, i) => ({ user_id: `u${f + i}` })), error: null });
      },
    };
    return q;
  };
  try {
    const d = m.defaultDashboardDeps;
    assert.equal((await d.listKeys()).length, 1005);
    assert.equal((await d.listUsage('2026-09-01')).length, 1005);
    assert.equal((await d.listRecentStt('2026-10-08T00:00:00Z')).length, 1005);
    assert.equal((await d.listFreeCredits()).length, 1005);
    assert.equal((await d.listBilling()).length, 1005);
  } finally { sb.from = orig; }
  assert.deepEqual(calls.realtimetts_api_keys, ['order:created_at', 'order:gateway_key_id', 'range:0-999', 'order:created_at', 'order:gateway_key_id', 'range:1000-1999']);
  assert.deepEqual(calls.realtimetts_usage_daily.slice(0, 3), ['order:day', 'order:user_id', 'range:0-999']);
  assert.deepEqual(calls.stt_transcriptions.slice(0, 3), ['order:created_at', 'order:id', 'range:0-999']);
});

// --- final-review fixes ---------------------------------------------------------------------------------------
test('F2: an account with no credits row has the full free grant left (billing treats a missing row as granted FREE_CREDIT_UNITS, used 0), but is never "used up"', async () => {
  const m = await modP; const { FREE_CREDIT_UNITS } = await import('./realtimeTtsBilling.js');
  const i = await inputs({ credits: [] });
  const cs = m.buildCustomers(i);
  for (const id of ['a', 'b']) { const c = cs.find((x: any) => x.userId === id)!; assert.equal(c.creditsLeft, FREE_CREDIT_UNITS); }
  assert.equal(cs.find((x: any) => x.userId === 'b')!.status, 'free');
  const t = m.buildTotals(i);
  assert.equal(t.creditsGranted, 2 * FREE_CREDIT_UNITS);
  assert.equal(t.creditsUsed, 0);
  assert.equal(m.buildFunnel(i)[2]!.count, 0);
});

test('F3: chars7d and the spike rule include free-tier characters', async () => {
  const m = await modP;
  const usage = [
    ...Array.from({ length: 7 }, (_, d) => use('b', `2026-10-0${1 + d}`, { free_chars: 10000 })),
    use('b', '2026-10-08', { free_chars: 600000 }), use('a', '2026-10-08', { chars: 10, free_chars: 5 }),
  ];
  const i = await inputs({ usage, credits: [] });
  const b = m.buildCustomers(i).find((c: any) => c.userId === 'b')!;
  assert.equal(b.chars7d, 600000 + 6 * 10000);
  assert.equal(m.buildCustomers(i).find((c: any) => c.userId === 'a')!.chars7d, 15);
  assert.ok(m.buildAttention(i, m.buildCustomers(i)).some((x: any) => x.text === 'b@example.test: usage spike'));
});

test('F4: billedUnits only counts users with an active non-comped billing row', async () => {
  const m = await modP;
  const usage = [use('a', '2026-10-08', { chars: 1000 }), use('b', '2026-10-08', { chars: 5000 })];
  const base = { usage };
  const paidOnlyA = m.buildTotals(await inputs({ ...base, billing: [{ user_id: 'a', active: true }] }));
  const none = m.buildTotals(await inputs({ ...base, billing: [] }));
  const comped = m.buildTotals(await inputs({ ...base, billing: [{ user_id: 'a', active: true, comped: true }, { user_id: 'b', active: false }] }));
  assert.equal(none.billedUnits, 0);
  assert.equal(comped.billedUnits, 0);
  assert.ok(paidOnlyA.billedUnits > 0);
  const both = m.buildTotals(await inputs({ ...base, billing: [{ user_id: 'a', active: true }, { user_id: 'b', active: true }] }));
  assert.ok(both.billedUnits > paidOnlyA.billedUnits);
});

test('F5: "Made a first request" is the union of ledger usage, credits used and a paid card, so later stages never exceed it', async () => {
  const m = await modP;
  const i = await inputs({
    usage: [], // empty ledger (just shipped)
    credits: [{ user_id: 'b', granted: 1000, used: 1000 }],
    billing: [{ user_id: 'a', active: true }],
  });
  const f = m.buildFunnel(i);
  assert.equal(f[1]!.count, 2);
  assert.ok(f[2]!.count <= f[1]!.count && f[3]!.count <= f[1]!.count);
  const j = await inputs({ usage: [], credits: [{ user_id: 'a', granted: 1000, used: 0 }], billing: [] });
  assert.equal(m.buildFunnel(j)[1]!.count, 0);
});

test('F9: attention says so when the exclusion set resolves to nobody (unset, or a typo)', async () => {
  const m = await modP; const { parseExcludeEmails } = await modP;
  const msg = 'No accounts are excluded: ADMIN_EXCLUDE_EMAILS is unset or matches nobody';
  for (const ex of [parseExcludeEmails(undefined), parseExcludeEmails('typo@example.test')]) {
    const i = await inputs({ excluded: ex });
    assert.ok(m.buildAttention(i, m.buildCustomers(i)).some((x: any) => x.level === 'info' && x.text === msg));
  }
  const ok = await inputs();
  assert.ok(!m.buildAttention(ok, m.buildCustomers(ok)).some((x: any) => x.text === msg));
});

test('F6: the active probes start before the data fetch resolves', async () => {
  const m = await modP; const base = await inputs();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const deps = {
    now: () => NOW,
    listUsers: async () => { order.push('users:start'); await gate; order.push('users:done'); return base.users; },
    listKeys: async () => base.keys, listUsage: async () => base.usage, listFreeCredits: async () => base.credits,
    listBilling: async () => base.billing, listRecentStt: async () => [], firstUsageDay: async () => '2026-10-07',
    startProbes: async () => { order.push('probes:start'); return [{ name: 'gateway', status: 'up', checkedAt: NOW.toISOString() }]; },
    probes: async (_u: any, _s: any, active: any[] = []) => [...active, { name: 'kokoro', status: 'unknown', checkedAt: NOW.toISOString() }],
  };
  const p = m.buildDashboard(deps as any, { range: '7d', excludeEmails: base.excluded });
  await new Promise((r) => setImmediate(r));
  assert.ok(order.includes('probes:start') && !order.includes('users:done'), order.join(','));
  release();
  const r = await p;
  assert.deepEqual((r.health as any).data.map((h: any) => h.name), ['gateway', 'kokoro']);
});
