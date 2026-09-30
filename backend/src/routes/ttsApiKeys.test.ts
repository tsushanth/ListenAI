// Run: npm test. GET /api/tts-api-keys billing/free-credit/comped fields and the one-key limit for accounts without a payment method.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { installKit, billingRow, type Kit } from '../../test/billingKit.js';

// requireRealAuth verifies the bearer token over HTTP (axios) against ${SUPABASE_URL}/auth/v1/user; stub it.
const authStub = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'u1' })); });
authStub.listen(0);
authStub.unref();
process.env.SUPABASE_URL = `http://127.0.0.1:${(authStub.address() as AddressInfo).port}`;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.TTS_GATEWAY_ADMIN_SECRET = 'admin-secret';
process.env.TTS_GATEWAY_URL = 'http://gateway.test';
process.env.NODE_ENV = 'test';

async function call(method: string, path: string): Promise<{ status: number; body: any }> {
  const { ttsApiKeysRouter } = await import('./ttsApiKeys.js');
  const app = express();
  app.use(express.json());
  app.use('/keys', ttsApiKeysRouter);
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/keys${path}`, { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

const activeKey = (n: number) => ({ id: `k${n}`, user_id: 'u1', gateway_key_id: `gk${n}`, revoked_at: null, key_preview: 'x', label: null, created_at: 'now' });

test('GET: user with no billing row -> billing_active false, comped false, full untouched free credits', () => withKit(async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.equal(r.body.billing_active, false);
  assert.equal(r.body.comped, false);
  assert.deepEqual(r.body.free_credits, { granted: 10000, used: 0, remaining: 10000 });
}));

test('GET: reports used free credits', () => withKit(async (kit) => {
  kit.tables.realtimetts_free_credits!.push({ user_id: 'u1', granted: 10000, used: 2500 });
  const r = await call('GET', '/');
  assert.deepEqual(r.body.free_credits, { granted: 10000, used: 2500, remaining: 7500 });
}));

test('GET: paying user -> billing_active true, comped false', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
  const r = await call('GET', '/');
  assert.equal(r.body.billing_active, true);
  assert.equal(r.body.comped, false);
}));

test('GET: comped user -> billing_active true AND comped true', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1', comped: true }));
  const r = await call('GET', '/');
  assert.equal(r.body.billing_active, true);
  assert.equal(r.body.comped, true);
}));

test('GET: an inactive (cancelled) row is not "Pay-as-you-go active"', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1', active: false }));
  const r = await call('GET', '/');
  assert.equal(r.body.billing_active, false);
}));

test('POST: a free account may create its first key but gets 429 on the second', () => withKit(async (kit) => {
  const first = await call('POST', '/');
  assert.equal(first.status, 200);
  assert.equal(first.body.billing_active, false);
  assert.deepEqual(kit.gatewayCalls, [], 'a free account\'s key is not billing-enabled');
  const second = await call('POST', '/');
  assert.equal(second.status, 429);
  assert.match(second.body.error, /1 active API key/);
  assert.match(second.body.error, /readaloudai\.org\/developers#get-started/);
}));

test('POST: a paying account is not held to the free one-key limit', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
  kit.tables.realtimetts_api_keys!.push(activeKey(1), activeKey(2));
  const r = await call('POST', '/');
  assert.notEqual(r.status, 429);
}));

test('POST /billing/checkout: refused for a comped account', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1', comped: true }));
  const r = await call('POST', '/billing/checkout');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /complimentary/i);
}));

test('POST: a comped account\'s new key is billing-enabled on the gateway', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1', comped: true }));
  const r = await call('POST', '/');
  assert.equal(r.status, 200);
  assert.equal(r.body.billing_active, true);
  assert.deepEqual(kit.gatewayCalls, [{ id: 'gk_new', enabled: true }]);
}));
