// Run: npm test. GET /api/entitlement: strict auth (never the shared default pro user), tier from getUserTier's table.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import * as jose from 'jose';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { EntitlementDeps } from './entitlement.js';
import type { SourceRow } from '../lib/webEntitlement.js';
import { installKit } from '../../test/billingKit.js';

// Dynamic import: config validates env at import time, so the env above must be set first.
async function createEntitlementRouter(d?: EntitlementDeps): Promise<express.Router> {
  const mod = await import('./entitlement.js');
  return mod.createEntitlementRouter(d);
}

const U1 = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-03T12:00:00Z');

async function get(router: express.Router, authorization?: string): Promise<{ status: number; body: any; cache: string | null }> {
  const app = express();
  app.use('/api/entitlement', router);
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/api/entitlement`, { headers: authorization ? { authorization } : {} });
    return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
  } finally { server.close(); }
}

const stripeRow = (over: Partial<SourceRow> = {}): SourceRow => ({
  user_id: U1, source: 'stripe', tier: 'pro', status: 'trialing', stripe_customer_id: 'cus_secret', stripe_subscription_id: 'sub_secret',
  current_period_end: new Date(NOW + 86400_000).toISOString(), canceled_at: null, last_event_created: 1, ...over,
});

const deps = (over: Partial<EntitlementDeps> = {}): EntitlementDeps => ({
  authenticate: async (h) => { if (h !== 'Bearer good') throw new Error('bad token'); return { id: U1 }; },
  getTier: async () => 'pro',
  listSources: async () => [stripeRow()],
  webProEnabled: () => true,
  nowMs: () => NOW,
  ...over,
});

test('no or invalid token: 401, never an entitlement (even though requireAuth would map it to the default pro user)', async () => {
  const r = await createEntitlementRouter(deps());
  assert.equal((await get(r)).status, 401);
  assert.equal((await get(r, 'Bearer nope')).status, 401);
  assert.equal((await get(r, 'Basic abc')).status, 401);
});

test('signed-in pro user: tier, active flag and the per-source summary, with no Stripe ids leaked', async () => {
  const { status, body, cache } = await get(await createEntitlementRouter(deps()), 'Bearer good');
  assert.equal(status, 200);
  assert.equal(cache, 'no-store');
  assert.equal(body.tier, 'pro');
  assert.equal(body.active, true);
  assert.equal(body.web_pro_enabled, true);
  assert.equal(body.sources.length, 1);
  assert.deepEqual(Object.keys(body.sources[0]).sort(), ['active', 'current_period_end', 'source', 'status', 'tier']);
  assert.equal(JSON.stringify(body).includes('cus_secret'), false);
  assert.equal(JSON.stringify(body).includes('sub_secret'), false);
});

test('free user is inactive; a canceled source is listed as not active', async () => {
  const r = await createEntitlementRouter(deps({ getTier: async () => 'free', listSources: async () => [stripeRow({ tier: 'free', status: 'canceled' })] }));
  const { body } = await get(r, 'Bearer good');
  assert.equal(body.active, false);
  assert.equal(body.tier, 'free');
  assert.equal(body.sources[0].active, false);
});

test('reports whether the web Pro path is enabled', async () => {
  const { body } = await get(await createEntitlementRouter(deps({ webProEnabled: () => false })), 'Bearer good');
  assert.equal(body.web_pro_enabled, false);
});

test('the ledger table missing (migration not applied) still answers with the tier', async () => {
  const r = await createEntitlementRouter(deps({ listSources: async () => { throw new Error('relation "entitlement_sources" does not exist'); } }));
  const { status, body } = await get(r, 'Bearer good');
  assert.equal(status, 200);
  assert.deepEqual(body.sources, []);
  assert.equal(body.tier, 'pro');
});

test('a tier lookup failure is a 500, not a guess', async () => {
  const r = await createEntitlementRouter(deps({ getTier: async () => { throw new Error('db'); } }));
  assert.equal((await get(r, 'Bearer good')).status, 500);
});

test('end to end with the real auth and getUserTier: a real HS256 token reads subscriptions.plan_id; an anonymous call is 401', async () => {
  const kit = await installKit();
  try {
    kit.tables.subscriptions = [{ user_id: U1, plan_id: 'pro', status: 'active' }];
    kit.tables.entitlement_sources = [stripeRow()];
    const token = await new jose.SignJWT({ role: 'authenticated', email: 'a@example.com' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject(U1).setIssuer(`${process.env.SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET));
    const router = await createEntitlementRouter();
    const ok = await get(router, `Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tier, 'pro');
    assert.equal(ok.body.sources[0].source, 'stripe');
    assert.equal((await get(router)).status, 401);
    kit.tables.subscriptions = [];
    assert.equal((await get(router, `Bearer ${token}`)).body.tier, 'free');
  } finally { kit.restore(); }
});
