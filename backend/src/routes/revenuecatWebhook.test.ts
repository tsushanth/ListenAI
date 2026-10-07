import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { ApplyRecord } from '../lib/revenuecat/events.js';
import type { RevenueCatStore, ApplyResult } from '../lib/revenuecat/store.js';

const U = '11111111-2222-3333-4444-555555555555';

// In-memory store mirroring apply_revenuecat_event semantics (dedupe by id; older event_ts does not overwrite).
class MemStore implements RevenueCatStore {
  seen = new Set<string>(); rows = new Map<string, ApplyRecord>(); fail = false;
  async apply(r: ApplyRecord): Promise<ApplyResult> {
    if (this.fail) throw new Error('db down');
    if (this.seen.has(r.eventId)) return 'duplicate';
    this.seen.add(r.eventId);
    const cur = this.rows.get(r.userId);
    if (cur && cur.eventTsMs > r.eventTsMs) return 'stale';
    this.rows.set(r.userId, r); return 'applied';
  }
  async getEntitlement() { return null; }
}

async function boot(opts: { secret?: string | undefined; store?: MemStore } = {}) {
  const { createRevenueCatWebhookRouter } = await import('./revenuecatWebhook.js');
  const store = opts.store ?? new MemStore();
  const app = express();
  app.use('/api/webhooks', express.raw({ type: 'application/json' }), createRevenueCatWebhookRouter({
    store, secret: () => ('secret' in opts ? opts.secret : 'rc-secret'), config: () => ({ map: {}, acceptSandbox: false }),
  }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/revenuecat`;
  return { store, base, close: () => server.close() };
}
const ev = (o: Record<string, unknown>) => ({ api_version: '1.0', event: { id: 'e1', type: 'INITIAL_PURCHASE', event_timestamp_ms: 1000, app_user_id: U, product_id: 'p', entitlement_ids: ['premium'], expiration_at_ms: 9e12, environment: 'PRODUCTION', ...o } });
const send = (base: string, body: string | object, auth: string | null = 'rc-secret', ctype = 'application/json') =>
  fetch(base, { method: 'POST', headers: { 'content-type': ctype, ...(auth === null ? {} : { authorization: auth }) }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('503 when REVENUECAT_WEBHOOK_AUTH is unset (fail closed), even with a header', async () => {
  const b = await boot({ secret: undefined });
  try { assert.equal((await send(b.base, ev({}), 'anything')).status, 503); assert.equal(b.store.rows.size, 0); } finally { b.close(); }
});
test('401 for missing, wrong, and same-prefix auth', async () => {
  const b = await boot();
  try {
    assert.equal((await send(b.base, ev({}), null)).status, 401);
    assert.equal((await send(b.base, ev({}), 'nope')).status, 401);
    assert.equal((await send(b.base, ev({}), 'rc-secre')).status, 401);
    assert.equal((await send(b.base, ev({}), 'rc-secret-extra')).status, 401);
    assert.equal(b.store.rows.size, 0);
  } finally { b.close(); }
});
test('valid event applies; duplicate id is a no-op 200', async () => {
  const b = await boot();
  try {
    const r1 = await send(b.base, ev({})); assert.equal(r1.status, 200); assert.equal((await r1.json() as any).result, 'applied');
    const r2 = await send(b.base, ev({})); assert.equal(r2.status, 200); assert.equal((await r2.json() as any).result, 'duplicate');
    assert.equal(b.store.rows.get(U)?.status, 'active');
  } finally { b.close(); }
});
test('out-of-order: older EXPIRATION arriving after newer RENEWAL does not overwrite', async () => {
  const b = await boot();
  try {
    await send(b.base, ev({ id: 'new', type: 'RENEWAL', event_timestamp_ms: 2000 }));
    const r = await send(b.base, ev({ id: 'old', type: 'EXPIRATION', event_timestamp_ms: 1500 }));
    assert.equal((await r.json() as any).result, 'stale');
    assert.equal(b.store.rows.get(U)?.status, 'active');
  } finally { b.close(); }
});
test('anonymous id: 200 ignored, nothing stored (no endless retries)', async () => {
  const b = await boot();
  try {
    const r = await send(b.base, ev({ app_user_id: '$RCAnonymousID:abc123' }));
    assert.equal(r.status, 200); assert.ok((await r.json() as any).ignored); assert.equal(b.store.rows.size, 0);
  } finally { b.close(); }
});
test('TEST event 200', async () => {
  const b = await boot();
  try { assert.equal((await send(b.base, ev({ type: 'TEST' }))).status, 200); } finally { b.close(); }
});
test('400 for invalid JSON, missing event, oversize, wrong content type', async () => {
  const b = await boot();
  try {
    assert.equal((await send(b.base, '{not json')).status, 400);
    assert.equal((await send(b.base, { nope: 1 })).status, 400);
    assert.equal((await send(b.base, { event: [] })).status, 400);
    assert.equal((await send(b.base, JSON.stringify({ event: { pad: 'x'.repeat(70_000) } }))).status, 400);
    assert.equal((await send(b.base, 'hi', 'rc-secret', 'text/plain')).status, 400);
  } finally { b.close(); }
});
test('store failure -> 500 so RevenueCat retries', async () => {
  const s = new MemStore(); s.fail = true; const b = await boot({ store: s });
  try { assert.equal((await send(b.base, ev({}))).status, 500); } finally { b.close(); }
});
test('authOk is exact', async () => {
  const { authOk } = await import('./revenuecatWebhook.js');
  assert.equal(authOk('a', 'a'), true); assert.equal(authOk(undefined, 'a'), false); assert.equal(authOk('', ''), false);
});
