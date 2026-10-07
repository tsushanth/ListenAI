// npm test (node:test via tsx). POST /api/subscription/sync must not trust client-supplied tier data.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';


test('client-driven sync is disabled unless explicitly enabled', async () => {
  const { subscriptionSyncEnabled } = await import('./subscription.js');
  assert.equal(subscriptionSyncEnabled({}), false);
  assert.equal(subscriptionSyncEnabled({ SUBSCRIPTION_SYNC_TRUSTS_CLIENT: 'false' }), false);
  assert.equal(subscriptionSyncEnabled({ SUBSCRIPTION_SYNC_TRUSTS_CLIENT: 'true' }), true);
});

test('POST /sync acknowledges but writes nothing while disabled (no Supabase call, no tier granted)', async () => {
  const { subscriptionRouter } = await import('./subscription.js');
  delete process.env.SUBSCRIPTION_SYNC_TRUSTS_CLIENT;
  const realFetch = globalThis.fetch;
  let supabaseCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input).startsWith('http://localhost:54321')) { supabaseCalls++; return new Response('[]', { status: 200 }); }
    return realFetch(input, init);
  }) as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 'user-1' }; next(); });
  app.use('/api/subscription', subscriptionRouter);
  const server = app.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await realFetch(`http://127.0.0.1:${port}/api/subscription/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product_id: 'pro_annual', transaction_id: 't1', expires_date: '2099-01-01T00:00:00Z' }),
    });
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.success, false);
    assert.equal(j.synced, false);
    assert.equal(supabaseCalls, 0, 'must not read or write subscriptions/quotas');
  } finally {
    server.close();
    globalThis.fetch = realFetch;
  }
});
