import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { PlanDeps } from './runtime.js';
const planForUser = async (u: string, d: PlanDeps) => (await import('./runtime.js')).planForUser(u, d);

const NOW = Date.parse('2026-10-06T00:00:00Z');
const FUTURE = '2026-11-06T00:00:00Z', PAST = '2026-09-06T00:00:00Z';
const mk = (billing: any, ent: any | 'throw'): PlanDeps => ({
  getBilling: async () => billing,
  getEntitlement: async () => { if (ent === 'throw') throw new Error('db'); return ent; },
  now: () => NOW,
});
const ent = (o: Record<string, unknown> = {}) => ({ user_id: 'u', plan_id: 'basic', status: 'active', expires_at: FUTURE, ...o });

test('no billing, no entitlement -> null', async () => assert.equal(await planForUser('u', mk(null, null)), null));
test('active billing -> paid', async () => assert.equal(await planForUser('u', mk({ active: true, comped: false }, null)), 'paid'));
test('comped billing -> comped', async () => assert.equal(await planForUser('u', mk({ active: true, comped: true }, null)), 'comped'));
test('comped wins over an active entitlement', async () => assert.equal(await planForUser('u', mk({ active: true, comped: true }, ent())), 'comped'));
test('inactive billing + active unexpired entitlement -> paid', async () => assert.equal(await planForUser('u', mk({ active: false }, ent())), 'paid'));
test('no billing row + active entitlement (pro) -> paid', async () => assert.equal(await planForUser('u', mk(null, ent({ plan_id: 'pro' }))), 'paid'));
test('expired status -> null', async () => assert.equal(await planForUser('u', mk(null, ent({ status: 'expired' }))), null));
test('active status but past expiry -> null', async () => assert.equal(await planForUser('u', mk(null, ent({ expires_at: PAST }))), null));
test('free plan entitlement -> null', async () => assert.equal(await planForUser('u', mk(null, ent({ plan_id: 'free' }))), null));
test('missing expires_at -> null', async () => assert.equal(await planForUser('u', mk(null, ent({ expires_at: null }))), null));
test('entitlement lookup error fails closed', async () => assert.equal(await planForUser('u', mk(null, 'throw')), null));
test('cancelled-but-unexpired stays paid; synthesis re-check follows expiry', async () => {
  assert.equal(await planForUser('u', mk(null, ent({ canceled_at: PAST }))), 'paid');
  assert.equal(await planForUser('u', mk(null, ent({ expires_at: PAST, canceled_at: PAST }))), null);
});
