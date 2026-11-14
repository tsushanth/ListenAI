// npm test (node:test via tsx). Unit tests for lib/apiKeyResolver.ts: public rtts_ key -> owning account.
// The gateway is a local stub HTTP server and the ownership table is a stub PostgREST server, so nothing
// leaves this process. Fixture keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import { createApiKeyResolver, looksLikeRtts, digestKey } from './apiKeyResolver.js';

const KEY_A = 'rtts_fixtureKeyAAAAAAAAAAAA';
const KEY_REVOKED = 'rtts_fixtureKeyRevokedXXXX';
const KEY_EXHAUSTED = 'rtts_fixtureKeyExhaustedYY';
const KEY_ORPHAN = 'rtts_fixtureKeyOrphanZZZZZ';

function bootGateway(handler?: (key: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const key = JSON.parse(raw || '{}').key as string;
      calls.push(`${req.method} ${req.url}`);
      const out = handler
        ? handler(key)
        : key === KEY_A ? { status: 200, body: { authorized: true, id: 'gk-A' } }
        : key === KEY_ORPHAN ? { status: 200, body: { authorized: true, id: 'gk-orphan' } }
        : key === KEY_EXHAUSTED ? { status: 402, body: { error: 'x' } }
        : { status: 401, body: { error: 'invalid or missing API key' } };
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  server.listen(0);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => server.close() };
}

function mk(gw: { url: string }, over: Record<string, unknown> = {}) {
  const owners: Record<string, string | null> = { 'gk-A': 'user-A', 'gk-orphan': null };
  let t = 1_000_000;
  const lookups: string[] = [];
  const r = createApiKeyResolver({
    gatewayUrl: gw.url,
    fetchImpl: fetch,
    lookupOwner: async (id) => { lookups.push(id); return owners[id] ?? null; },
    now: () => t,
    cacheTtlMs: 10_000,
    timeoutMs: 2000,
    ...over,
  });
  return { r, owners, lookups, advance: (ms: number) => { t += ms; } };
}

test('valid key resolves to the owning account and the gateway key id', async () => {
  const gw = bootGateway();
  try {
    const { r } = mk(gw);
    const res = await r.resolve(KEY_A);
    assert.deepEqual(res, { ok: true, userId: 'user-A', keyId: 'gk-A' });
    assert.deepEqual(gw.calls, ['POST /dubbing/authorize']);
  } finally { gw.close(); }
});

test('invalid or revoked key at the gateway is a 401 and never reaches the ownership lookup', async () => {
  const gw = bootGateway();
  try {
    const { r, lookups } = mk(gw);
    const res = await r.resolve(KEY_REVOKED);
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 401);
    assert.equal(lookups.length, 0);
  } finally { gw.close(); }
});

test('key the gateway accepts but with no live account record is 403 key_not_linked (never a made-up account)', async () => {
  const gw = bootGateway();
  try {
    const { r } = mk(gw);
    const res = await r.resolve(KEY_ORPHAN);
    assert.equal(res.ok, false);
    assert.equal((res as { status: number }).status, 403);
    assert.equal((res as { code: string }).code, 'key_not_linked');
  } finally { gw.close(); }
});

test('gateway 402 (free credits used up) maps to 402; 429 keeps Retry-After; 5xx and bad bodies fail closed as 503', async () => {
  const gw = bootGateway();
  try {
    const { r } = mk(gw);
    assert.equal((await r.resolve(KEY_EXHAUSTED) as { status: number }).status, 402);
  } finally { gw.close(); }
  const gw429 = bootGateway(() => ({ status: 429, headers: { 'retry-after': '7' } }));
  try {
    const res = await mk(gw429).r.resolve(KEY_A) as { status: number; retryAfterSec: number };
    assert.equal(res.status, 429);
    assert.equal(res.retryAfterSec, 7);
  } finally { gw429.close(); }
  for (const h of [() => ({ status: 500 }), () => ({ status: 200, body: { authorized: false } }), () => ({ status: 200, body: { authorized: true } }), () => ({ status: 404 })]) {
    const g = bootGateway(h);
    try { assert.equal((await mk(g).r.resolve(KEY_A) as { status: number }).status, 503); } finally { g.close(); }
  }
});

test('gateway unreachable fails closed as 503, ownership lookup error fails closed as 503', async () => {
  const dead = http.createServer(); dead.listen(0);
  const port = (dead.address() as AddressInfo).port; dead.close();
  assert.equal((await mk({ url: `http://127.0.0.1:${port}` }).r.resolve(KEY_A) as { status: number }).status, 503);
  const gw = bootGateway();
  try {
    const { r } = mk(gw, { lookupOwner: async () => { throw new Error('db down'); } });
    assert.equal((await r.resolve(KEY_A) as { status: number }).status, 503);
  } finally { gw.close(); }
});

test('wrong-shaped keys are rejected locally without any network call', async () => {
  const gw = bootGateway();
  try {
    const { r } = mk(gw);
    for (const k of ['', 'rtts_', 'sk_live_abc', 'abc', `rtts_${'a'.repeat(300)}`, 'rtts_has space', 'rtts_semi;colon']) {
      assert.equal((await r.resolve(k) as { status: number }).status, 401, k.slice(0, 12));
    }
    assert.equal(gw.calls.length, 0);
    assert.equal(looksLikeRtts(KEY_A), true);
  } finally { gw.close(); }
});

test('a successful resolution is cached for the TTL only, so a revocation takes effect after it', async () => {
  let revoked = false;
  const gw = bootGateway((k) => (k === KEY_A && !revoked ? { status: 200, body: { authorized: true, id: 'gk-A' } } : { status: 401 }));
  try {
    const { r, advance } = mk(gw);
    assert.equal((await r.resolve(KEY_A)).ok, true);
    assert.equal((await r.resolve(KEY_A)).ok, true);
    assert.equal(gw.calls.length, 1, 'second call served from cache');
    revoked = true;
    advance(9_000);
    assert.equal((await r.resolve(KEY_A)).ok, true, 'still inside TTL');
    advance(2_000);
    assert.equal((await r.resolve(KEY_A) as { status: number }).status, 401, 'revoked key rejected once the TTL passes');
  } finally { gw.close(); }
});

test('cacheTtlMs 0 disables the cache; failures are never cached', async () => {
  const gw = bootGateway();
  try {
    const { r } = mk(gw, { cacheTtlMs: 0 });
    await r.resolve(KEY_A); await r.resolve(KEY_A);
    assert.equal(gw.calls.length, 2);
    await r.resolve(KEY_REVOKED); await r.resolve(KEY_REVOKED);
    assert.equal(gw.calls.length, 4);
  } finally { gw.close(); }
});

test('the raw key is never stored: cache is keyed by a digest, and the digest is not the key', () => {
  const d = digestKey(KEY_A);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.ok(!d.includes(KEY_A));
});

// --- the real ownership lookup, against a stub PostgREST ------------------------------------------------------
test('lookupOwnerFromDb queries realtimetts_api_keys by gateway key id, live keys only', async () => {
  const seen: string[] = [];
  const rest = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    const u = new URL(req.url ?? '', 'http://x');
    const wantsObject = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
    const live = u.searchParams.get('gateway_key_id') === 'eq.gk-A' && u.searchParams.get('revoked_at') === 'is.null';
    const rows = live ? [{ user_id: 'user-A' }] : [];
    if (wantsObject && !rows.length) { res.writeHead(406, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'PGRST116', message: 'none', details: '', hint: null })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(wantsObject ? rows[0] : rows));
  });
  rest.listen(0);
  process.env.SUPABASE_URL = `http://127.0.0.1:${(rest.address() as AddressInfo).port}`;
  try {
    const { lookupOwnerFromDb } = await import('./apiKeyResolver.js');
    assert.equal(await lookupOwnerFromDb('gk-A'), 'user-A');
    assert.equal(await lookupOwnerFromDb('gk-other'), null);
    assert.ok(seen.every((u) => u.includes('/rest/v1/realtimetts_api_keys') && u.includes('revoked_at=is.null')), seen.join('\n'));
  } finally { rest.close(); }
});
