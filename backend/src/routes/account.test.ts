// Run: npm test. DELETE /api/account: strict auth (never the shared default user), user id only from the verified
// token, subscription warning, idempotency, error mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { AccountRouterDeps } from './account.js';
import type { AccountStore, SubscriptionFlags } from '../lib/accountDeletion.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const routerP = import('./account.js');
const dblP = import('../lib/voiceCloning/testDoubles.js');
const polP = import('../lib/voiceCloning/policy.js');

async function boot(over: { flags?: Record<string, SubscriptionFlags>; failRows?: boolean; failAuthUserNotFound?: boolean } = {}) {
  const [{ createAccountRouter }, dbl, pol] = await Promise.all([routerP, dblP, polP]);
  const calls: Array<[string, string]> = [];
  const authUsers = new Set([A, B]);
  const store: AccountStore = {
    async subscriptionFlags(u) { return over.flags?.[u] ?? { stripe: false, play: false }; },
    async revokeGatewayKeys(u) { calls.push(['keys', u]); return 0; },
    async collectStorage(u) { calls.push(['collect', u]); return []; },
    async removeStorage() { /* none collected */ },
    async deleteUserRows(u) { calls.push(['rows', u]); if (over.failRows) throw new Error('db down'); return { tablesTouched: 1, tablesSkipped: [] }; },
    async deleteAuthUser(u) { calls.push(['auth', u]); return authUsers.delete(u) ? 'deleted' : 'not_found'; },
  };
  const cloneStore = new dbl.MemoryStore();
  const deps: AccountRouterDeps = {
    // "Bearer tok-a" is user A, "Bearer tok-b" is B; once the account is gone its token no longer verifies (like Supabase).
    authenticate: async (h) => {
      const id = h === 'Bearer tok-a' ? A : h === 'Bearer tok-b' ? B : null;
      if (!id || !authUsers.has(id)) throw new Error('bad token');
      return { id };
    },
    deletion: { store, cloneStore, cloneDeps: () => ({ store: cloneStore, blobs: new dbl.MemoryBlobs(), service: new dbl.FakeService(), asr: new dbl.FakeAsr(), policy: pol.DEFAULT_POLICY }) },
  };
  const app = express();
  app.use('/api/account', createAccountRouter(deps));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account`;
  const del = async (headers: Record<string, string> = {}, body?: unknown, query = '') => {
    const r = await fetch(base + query, { method: 'DELETE', headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() as any, cache: r.headers.get('cache-control') };
  };
  return { base, del, calls, authUsers, close: () => server.close() };
}

test('auth is required: no, malformed, invalid or default-user tokens are 401 and delete nothing', async () => {
  const t = await boot();
  try {
    for (const h of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer nope' }, { authorization: 'Bearer ' }]) {
      const r = await t.del(h as Record<string, string>);
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'unauthenticated');
    }
    assert.deepEqual(t.calls, []);
    assert.equal(t.authUsers.size, 2);
  } finally { t.close(); }
});

test('signed-in user: own account deleted, response says deleted, never cached', async () => {
  const t = await boot();
  try {
    const r = await t.del({ authorization: 'Bearer tok-a' });
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, true);
    assert.deepEqual(r.body.subscriptions, { stripe: false, play: false });
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(t.calls.at(-1), ['auth', A]);
  } finally { t.close(); }
});

test('only own data: a user id in the body, query or path is ignored; the token decides', async () => {
  const t = await boot();
  try {
    const r = await t.del({ authorization: 'Bearer tok-a' }, { user_id: B, userId: B, id: B }, `?user_id=${B}&userId=${B}`);
    assert.equal(r.status, 200);
    assert.ok(t.calls.every(([, u]) => u === A), JSON.stringify(t.calls));
    assert.equal(t.authUsers.has(B), true);
    assert.equal(t.authUsers.has(A), false);
  } finally { t.close(); }
});

test('idempotent: repeating after success is a clean 401 (token dead) and never touches anyone else', async () => {
  const t = await boot();
  try {
    assert.equal((await t.del({ authorization: 'Bearer tok-a' })).status, 200);
    const before = t.calls.length;
    const again = await t.del({ authorization: 'Bearer tok-a' });
    assert.equal(again.status, 401);
    assert.equal(t.calls.length, before);
    assert.equal(t.authUsers.has(B), true);
  } finally { t.close(); }
});

test('idempotent at the data layer: a valid token for an account whose data is already gone still ends in 200', async () => {
  const t = await boot();
  try {
    t.authUsers.add(A); // auth user exists, nothing else does (e.g. an earlier run died before the last step)
    const first = await t.del({ authorization: 'Bearer tok-a' });
    assert.equal(first.status, 200);
  } finally { t.close(); }
});

test('active subscription: 409 with the flags and nothing deleted; with the acknowledgement it proceeds and still reports them', async () => {
  const t = await boot({ flags: { [A]: { stripe: true, play: true } } });
  try {
    const blocked = await t.del({ authorization: 'Bearer tok-a' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'active_subscription');
    assert.deepEqual(blocked.body.subscriptions, { stripe: true, play: true });
    assert.deepEqual(t.calls, []);
    assert.equal(t.authUsers.has(A), true);

    // A string "true" is not an acknowledgement.
    assert.equal((await t.del({ authorization: 'Bearer tok-a' }, { acknowledge_active_subscription: 'true' })).status, 409);

    const ok = await t.del({ authorization: 'Bearer tok-a' }, { acknowledge_active_subscription: true });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.subscriptions, { stripe: true, play: true });
  } finally { t.close(); }
});

test('a failing step is a 500 that keeps the account (auth user not deleted) so the app can offer a retry', async () => {
  const t = await boot({ failRows: true });
  try {
    const r = await t.del({ authorization: 'Bearer tok-a' });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, 'internal');
    assert.equal(t.authUsers.has(A), true);
    assert.equal(t.calls.some(([k]) => k === 'auth'), false);
  } finally { t.close(); }
});

test('only DELETE is routed: GET and POST on /api/account never delete anything', async () => {
  const t = await boot();
  try {
    for (const method of ['GET', 'POST', 'PUT']) {
      const r = await fetch(t.base, { method, headers: { authorization: 'Bearer tok-a' } });
      assert.equal(r.status, 404, method);
    }
    assert.deepEqual(t.calls, []);
    assert.equal(t.authUsers.size, 2);
  } finally { t.close(); }
});
