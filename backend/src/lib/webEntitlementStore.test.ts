// Run: npm test. The Supabase-backed store: which tables, columns and conflict keys it uses (against a recording fake).
// This cannot prove the SQL works against a real database; migration 036 is not applied anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

type Call = { table: string; steps: Array<[string, unknown[]]> };

async function withFake(result: (c: Call) => { data?: unknown; error?: unknown }, fn: (calls: Call[]) => Promise<void>) {
  const { supabase } = await import('./supabaseClient.js');
  const sb = supabase as any;
  const original = sb.from;
  const calls: Call[] = [];
  sb.from = (table: string) => {
    const call: Call = { table, steps: [] };
    calls.push(call);
    const b: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null, ...result(call) }).then(res);
        return (...args: unknown[]) => { call.steps.push([prop, args]); return b; };
      },
    });
    return b;
  };
  try { await fn(calls); } finally { sb.from = original; }
}

const step = (c: Call, name: string) => c.steps.find(([n]) => n === name)?.[1];

test('claimEvent: true on insert, false on a primary-key conflict (23505), throws on anything else', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({}), async (calls) => {
    assert.equal(await s.claimEvent('evt_1', 'checkout.session.completed'), true);
    assert.equal(calls[0]!.table, 'stripe_webhook_events');
    assert.deepEqual(step(calls[0]!, 'insert'), [{ event_id: 'evt_1', type: 'checkout.session.completed' }]);
  });
  await withFake(() => ({ error: { code: '23505', message: 'duplicate key' } }), async () => assert.equal(await s.claimEvent('evt_1', 't'), false));
  await withFake(() => ({ error: { code: '42P01', message: 'relation does not exist' } }), async () => assert.rejects(s.claimEvent('evt_1', 't'), /claimEvent failed/));
});

test('writeEffective upserts the table getUserTier reads, keyed on user_id, marking the row ledger-managed', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({}), async (calls) => {
    await s.writeEffective('u1', { tier: 'pro', status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', current_period_end: null, canceled_at: null });
    const [row, opts] = step(calls[0]!, 'upsert') as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(calls[0]!.table, 'subscriptions');
    assert.deepEqual(opts, { onConflict: 'user_id' });
    assert.equal(row.plan_id, 'pro');
    assert.equal(row.entitlement_managed, true);
    assert.equal(row.user_id, 'u1');
  });
});

test('upsertSource uses the (user_id, source) unique key', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({}), async (calls) => {
    await s.upsertSource({ user_id: 'u1', source: 'stripe', tier: 'pro', status: 'active', stripe_customer_id: null, stripe_subscription_id: 'sub_1', current_period_end: null, canceled_at: null, last_event_created: 5 });
    assert.equal(calls[0]!.table, 'entitlement_sources');
    assert.deepEqual((step(calls[0]!, 'upsert') as unknown[])[1], { onConflict: 'user_id,source' });
  });
});

test('findUserIdByEmail returns an id only for exactly one match, and escapes LIKE wildcards', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({ data: [{ id: 'u1' }] }), async (calls) => {
    assert.equal(await s.findUserIdByEmail('a_b%c@x.com'), 'u1');
    assert.deepEqual(step(calls[0]!, 'ilike'), ['email', 'a\\_b\\%c@x.com']);
  });
  await withFake(() => ({ data: [{ id: 'u1' }, { id: 'u2' }] }), async () => assert.equal(await s.findUserIdByEmail('a@x.com'), null));
  await withFake(() => ({ data: [] }), async () => assert.equal(await s.findUserIdByEmail('a@x.com'), null));
});

test('ensureAppUser inserts only when missing (ignoreDuplicates) and never overwrites a profile', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({}), async (calls) => {
    await s.ensureAppUser('u1', 'a@x.com');
    assert.equal(calls[0]!.table, 'app_users');
    assert.deepEqual(step(calls[0]!, 'upsert'), [{ id: 'u1', email: 'a@x.com' }, { onConflict: 'id', ignoreDuplicates: true }]);
  });
});

test('getSubscription treats a missing entitlement_managed as false', async () => {
  const { supabaseEntitlementStore: s } = await import('./webEntitlementStore.js');
  await withFake(() => ({ data: [{ plan_id: 'unlimited', entitlement_managed: null }] }), async () =>
    assert.deepEqual(await s.getSubscription('u1'), { plan_id: 'unlimited', entitlement_managed: false }));
  await withFake(() => ({ data: [] }), async () => assert.equal(await s.getSubscription('u1'), null));
});
