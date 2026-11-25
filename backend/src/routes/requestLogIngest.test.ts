// backend/src/routes/requestLogIngest.test.ts
// Run: npm test. POST /api/gateway/request-log: gate (flag, secret), body limits, validation, insert, logging hygiene.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./requestLogIngest.js');
const NOW = new Date('2026-11-24T12:00:00.000Z');
const SECRET = 'a'.repeat(32); // dummy, low entropy on purpose (secret scanners)
const WRONG = 'b'.repeat(16);

const ev = (over: Record<string, unknown> = {}) => ({
  ts: '2026-11-24T11:59:58.250Z', request_id: 'req-1', gateway_key_id: 'key-uuid-1', transport: 'http',
  endpoint: '/v1/text-to-speech/stream', voice: 'mira', language: 'en', chars: 120, outcome: 'ok',
  http_status: 200, error_code: null, ttfb_ms: 180, duration_ms: 950, ...over,
});

type Inserted = unknown[][];
async function serve(o: { enabled?: boolean; secret?: string | undefined; insert?: (rows: any[]) => Promise<void> } = {}) {
  const { createRequestLogIngestRouter } = await modP;
  const inserted: Inserted = [];
  const app = express();
  app.use('/api/gateway/request-log', createRequestLogIngestRouter({
    enabled: () => o.enabled ?? true,
    secret: () => ('secret' in o ? o.secret : SECRET),
    now: () => NOW,
    insert: o.insert ?? (async (rows) => { inserted.push(rows); }),
  }));
  const srv = app.listen(0);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/gateway/request-log`;
  return { url, inserted, close: () => srv.close() };
}
const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-gateway-admin-secret': SECRET }, raw = false) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ? (body as string) : JSON.stringify(body) });

test('flag off: 404 "Not found" even with the right secret, and nothing is inserted', async () => {
  const s = await serve({ enabled: false });
  try {
    const r = await post(s.url, { events: [ev()] });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'Not found');
    assert.equal(s.inserted.length, 0);
  } finally { s.close(); }
});

test('wrong, missing, empty and array-valued secret: 404 "Not found", identical to flag off', async () => {
  const s = await serve();
  try {
    for (const h of [{}, { 'x-gateway-admin-secret': 'nope' }, { 'x-gateway-admin-secret': '' }, { 'x-gateway-admin-secret': SECRET + 'x' }, { 'x-gateway-admin-secret': SECRET.slice(1) }, { authorization: `Bearer ${SECRET}` }]) {
      const r = await post(s.url, { events: [ev()] }, h);
      assert.equal(r.status, 404, JSON.stringify(h));
      assert.equal(await r.text(), 'Not found');
    }
    assert.equal(s.inserted.length, 0);
  } finally { s.close(); }
});

test('unset server secret fails closed (even an empty header cannot match)', async () => {
  const s = await serve({ secret: undefined });
  try {
    assert.equal((await post(s.url, { events: [ev()] }, {})).status, 404);
    assert.equal((await post(s.url, { events: [ev()] }, { 'x-gateway-admin-secret': 'undefined' })).status, 404);
  } finally { s.close(); }
});

test('auth is checked before the body: a bad secret with a garbage or oversize body is still a plain 404', async () => {
  const s = await serve();
  try {
    const bad = { 'x-gateway-admin-secret': 'nope' };
    assert.equal((await post(s.url, '{not json', bad, true)).status, 404);
    assert.equal((await post(s.url, 'x'.repeat(400_000), bad, true)).status, 404);
  } finally { s.close(); }
});

test('only POST / exists: GET and other paths are 404 even with the secret', async () => {
  const s = await serve();
  try {
    const h = { 'x-gateway-admin-secret': SECRET };
    assert.equal((await fetch(s.url, { headers: h })).status, 404);
    assert.equal((await fetch(s.url, { method: 'PUT', headers: h })).status, 404);
    assert.equal((await fetch(`${s.url}/other`, { method: 'POST', headers: h })).status, 404);
  } finally { s.close(); }
});

test('valid batch: 202 {accepted, rejected}, one bulk insert of the validated rows', async () => {
  const s = await serve();
  try {
    const r = await post(s.url, { events: [ev(), ev({ request_id: 'req-2', ts: '2026-11-24T11:59:59+00:00' })] });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 2, rejected: 0 });
    assert.equal(s.inserted.length, 1);
    assert.equal(s.inserted[0]!.length, 2);
    assert.equal((s.inserted[0]![1] as any).ts, '2026-11-24T11:59:59.000Z');
  } finally { s.close(); }
});

test('partial rejection: valid events stored, invalid dropped individually and counted', async () => {
  const s = await serve();
  try {
    const r = await post(s.url, { events: [ev(), ev({ outcome: 'weird' }), ev({ text: 'leak' }), ev({ request_id: 'req-4' }), 'junk', null] });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 2, rejected: 4 });
    assert.deepEqual(s.inserted[0]!.map((x: any) => x.request_id), ['req-1', 'req-4']);
  } finally { s.close(); }
});

test('all events invalid or none sent: 202, nothing inserted', async () => {
  const s = await serve();
  try {
    const r = await post(s.url, { events: [ev({ chars: -5 })] });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { accepted: 0, rejected: 1 });
    const e = await post(s.url, { events: [] });
    assert.equal(e.status, 202);
    assert.deepEqual(await e.json(), { accepted: 0, rejected: 0 });
    assert.equal(s.inserted.flat().length, 0);
  } finally { s.close(); }
});

test('200 events accepted, 201 rejected with 413 and nothing inserted', async () => {
  const s = await serve();
  try {
    const ok = await post(s.url, { events: Array.from({ length: 200 }, (_, i) => ev({ request_id: `r${i}` })) });
    assert.equal(ok.status, 202);
    assert.deepEqual(await ok.json(), { accepted: 200, rejected: 0 });
    const big = await post(s.url, { events: Array.from({ length: 201 }, () => ev()) });
    assert.equal(big.status, 413);
    assert.equal(s.inserted.length, 1, 'only the 200-event batch was inserted');
  } finally { s.close(); }
});

test('malformed bodies: 400 (bad JSON, wrong shape, no content-type, events not an array)', async () => {
  const s = await serve();
  try {
    assert.equal((await post(s.url, '{not json', undefined, true)).status, 400);
    for (const body of [{}, { events: 'x' }, { events: { a: 1 } }, [ev()], 'plain', 7]) {
      assert.equal((await post(s.url, body)).status, 400, JSON.stringify(body));
    }
    const noType = await fetch(s.url, { method: 'POST', headers: { 'x-gateway-admin-secret': SECRET, 'content-type': 'text/plain' }, body: JSON.stringify({ events: [ev()] }) });
    assert.equal(noType.status, 400);
    assert.equal(s.inserted.length, 0);
  } finally { s.close(); }
});

test('body over 256 KB is 413 before validation (even if it would be a valid batch)', async () => {
  const s = await serve();
  try {
    const r = await post(s.url, { events: [ev({ voice: 'v' })], pad: 'x'.repeat(270_000) });
    assert.equal(r.status, 413);
    // 200 maximal-size events are about 80 KB, so a legitimate batch is far under the cap
    const max = Array.from({ length: 200 }, () => ev({ endpoint: 'e'.repeat(120), voice: 'v'.repeat(60), request_id: 'r'.repeat(80), gateway_key_id: 'k'.repeat(80), error_code: 'c'.repeat(60) }));
    assert.ok(Buffer.byteLength(JSON.stringify({ events: max })) < 256 * 1024);
    assert.equal((await post(s.url, { events: max })).status, 202);
  } finally { s.close(); }
});

test('insert failure: 500 {error:"ingest failed"} with no cause, no rows and no secret in the response', async () => {
  const s = await serve({ insert: async () => { throw new Error('connection to db.internal:5432 refused'); } });
  try {
    const r = await post(s.url, { events: [ev()] });
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), { error: 'ingest failed' });
    assert.ok(!/db\.internal|5432|req-1|key-uuid-1/.test(text));
  } finally { s.close(); }
});

test('logging hygiene: the failure is logged (message and count only), never the secret, rows or event values', async () => {
  const { createRequestLogIngestRouter } = await modP;
  const logged: unknown[] = [];
  const app = express();
  app.use('/r', createRequestLogIngestRouter({
    enabled: () => true, secret: () => SECRET, now: () => NOW,
    insert: async () => { throw new Error('insert exploded'); },
    logger: { error: (obj, msg) => { logged.push({ obj, msg }); } },
  }));
  const srv = app.listen(0);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r`;
  try {
    const r = await post(url, { events: [ev({ request_id: 'req-SENTINEL-77', gateway_key_id: 'key-SENTINEL-88' })] });
    assert.equal(r.status, 500);
    assert.equal((await post(url, { events: [ev()] }, { 'x-gateway-admin-secret': WRONG })).status, 404);
    assert.equal(logged.length, 1, 'rejected (404) requests log nothing; the insert failure logs once');
    const line = JSON.stringify(logged);
    assert.match(line, /request log insert failed/);
    assert.match(line, /insert exploded/);
    for (const bad of [SECRET, 'req-SENTINEL-77', 'key-SENTINEL-88', WRONG, 'mira', '/v1/text-to-speech/stream']) {
      assert.ok(!line.includes(bad), `log call must not contain ${bad}`);
    }
  } finally { srv.close(); }
});

test('the real logger redacts the gateway secret header', async () => {
  const { LOG_REDACT_PATHS } = await import('../lib/logger.js');
  assert.ok(LOG_REDACT_PATHS.includes('req.headers["x-gateway-admin-secret"]'));
});

test('default router (production wiring): off unless REQUEST_LOG_INGEST_ENABLED is set, 404 without the env secret', async () => {
  const { requestLogIngestRouter } = await modP;
  const prev = process.env.REQUEST_LOG_INGEST_ENABLED;
  delete process.env.REQUEST_LOG_INGEST_ENABLED;
  const app = express();
  app.use('/api/gateway/request-log', requestLogIngestRouter);
  const srv = app.listen(0);
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/gateway/request-log`;
  try {
    const r = await post(url, { events: [ev()] });
    assert.equal(r.status, 404);
    assert.equal(await r.text(), 'Not found');
    process.env.REQUEST_LOG_INGEST_ENABLED = '1'; // flag on but no GATEWAY_FORWARD_SECRET configured in tests: still closed
    assert.equal((await post(url, { events: [ev()] })).status, 404);
  } finally {
    if (prev === undefined) delete process.env.REQUEST_LOG_INGEST_ENABLED; else process.env.REQUEST_LOG_INGEST_ENABLED = prev;
    srv.close();
  }
});
