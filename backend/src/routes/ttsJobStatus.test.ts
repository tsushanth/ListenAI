// npm test (node:test via tsx). GET /api/tts/job/:jobId and POST .../cancel: a malformed or unknown job id is a 404 (never a 500),
// a DB error is still a 500 with the stable `code` from the error middleware and no database text in the body,
// and an anonymous caller is NOT rejected (requireAuth maps a missing token to the shared default user by design) but can only see 404.
// Supabase is a patched global.fetch (same pattern as textToMusic.test.ts); the real requireAuth, errorCodeNet and errorHandler are mounted.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const originalFetch = globalThis.fetch;
const dbCalls: string[] = [];
let dbMode: 'no_rows' | 'db_down' = 'no_rows';

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url.startsWith('http://localhost:54321/rest/v1/tts_jobs')) {
    dbCalls.push(url);
    const json = { 'Content-Type': 'application/json' };
    if (dbMode === 'db_down') {
      return new Response(JSON.stringify({ code: '57P01', message: 'terminating connection due to administrator command', details: 'row secret', hint: null }), { status: 500, headers: json });
    }
    // .single() with no matching row: PostgREST answers 406 / PGRST116
    return new Response(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows', hint: null }), { status: 406, headers: json });
  }
  return originalFetch(input, init);
};

async function boot() {
  const [{ ttsRouter }, { requireAuth }, { errorHandler }, { errorCodeNet }, { setRolloutPercent }] = await Promise.all([
    import('./tts.js'), import('../middleware/auth.js'), import('../middleware/errorHandler.js'),
    import('../middleware/errorCodeNet.js'), import('../lib/rollout.js'),
  ]);
  setRolloutPercent(100); // every user is in the job API rollout
  const app = express();
  app.use(express.json());
  app.use(errorCodeNet());
  app.use('/api/tts', requireAuth, ttsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tts`;
  return { base, close: () => server.close() };
}

const UNKNOWN = '11111111-1111-4111-8111-111111111111';

test('malformed job id is a 404 and never reaches the database', async () => {
  const { base, close } = await boot();
  try {
    dbCalls.length = 0;
    for (const id of ['abc', 'not-a-uuid', '1234', 'a'.repeat(80)]) {
      const r = await fetch(`${base}/job/${id}`);
      assert.equal(r.status, 404, id);
      const body = (await r.json()) as Record<string, unknown>;
      assert.equal(body.error, 'NOT_FOUND');
      assert.equal(body.message, 'Job not found');
      assert.equal(typeof body.code, 'string');
      const c = await fetch(`${base}/job/${id}/cancel`, { method: 'POST' });
      assert.equal(c.status, 404, `cancel ${id}`);
    }
    assert.equal(dbCalls.length, 0);
  } finally { close(); }
});

test('unknown but well-formed job id is a 404 (also for an anonymous caller: no token is not a 401 here)', async () => {
  const { base, close } = await boot();
  try {
    dbMode = 'no_rows';
    const r = await fetch(`${base}/job/${UNKNOWN}`);
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as Record<string, unknown>).message, 'Job not found');
    const c = await fetch(`${base}/job/${UNKNOWN}/cancel`, { method: 'POST' });
    assert.equal(c.status, 404);
  } finally { close(); }
});

test('cache-* pseudo ids still answer ready (unchanged behaviour)', async () => {
  const { base, close } = await boot();
  try {
    const r = await fetch(`${base}/job/cache-abcd1234`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as Record<string, unknown>).status, 'ready');
  } finally { close(); }
});

test('a real database failure is still a 500, with the error code and without database text in the body', async () => {
  const { base, close } = await boot();
  try {
    dbMode = 'db_down';
    const r = await fetch(`${base}/job/${UNKNOWN}`);
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.ok(!text.includes('terminating connection'), text);
    assert.ok(!text.includes('row secret'), text);
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.equal(body.error, 'INTERNAL_ERROR');
    assert.equal(typeof body.code, 'string');
  } finally { dbMode = 'no_rows'; close(); }
});
