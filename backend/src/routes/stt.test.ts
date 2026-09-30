// npm test (node:test via tsx). Unit tests for the customer-facing batch STT route
// (backend/src/routes/stt.ts): request validation, the auth gate, the billing gate,
// and rate limiting. All external calls (Supabase auth/REST, the STT gateway's
// /stt/authorize, and worker-stt-prod's /v1/stt) are intercepted via a patched
// global.fetch — nothing real is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.STT_API_KEY ??= 'house-stt-key';
process.env.STT_GATEWAY_URL ??= 'https://gateway.test';
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
let resolvedUserId = 'test-user-1';
let billingActive = true;
let sttWorkerResult: { text: string; language: string; duration: number } | { errorStatus: number; body?: string } =
  { text: 'hello world', language: 'en', duration: 3.5 };

const transcriptions = new Map<string, Record<string, unknown>>();
let idCounter = 0;
const workerCalls: Array<{ auth: string }> = [];
const authorizeCalls: { count: number } = { count: 0 };

let originalFetch: typeof globalThis.fetch;

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    // Supabase auth (JWT verification)
    if (url === 'http://localhost:54321/auth/v1/user') {
      const token = (init?.headers as Record<string, string>)?.['Authorization']?.replace(/^Bearer /, '') || '';
      if (token === 'valid-token') {
        return new Response(JSON.stringify({ id: resolvedUserId, aud: 'authenticated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ message: 'Invalid token', error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // Supabase REST — billing check
    if (url.includes('/realtimetts_free_credits')) {
      // Free-credit gate (hasUsageAllowance): exhausted, so inactive-billing tests still 402 quickly.
      return new Response(JSON.stringify([{ granted: 10000, used: 10000 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/rest/v1/realtimetts_billing')) {
      const u = new URL(url);
      const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '');
      if (billingActive && uid === resolvedUserId) {
        return new Response(JSON.stringify([{
          user_id: uid,
          stripe_customer_id: `cus_${uid}`,
          stripe_subscription_id: 'sub_test',
          stripe_subscription_item_id: 'si_test',
          active: true,
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Supabase REST — stt_transcriptions (insert/update/select/delete)
    if (url.includes('/rest/v1/stt_transcriptions')) {
      const method = (init?.method || 'GET').toUpperCase();
      const u = new URL(url);

      if (method === 'POST') {
        const body = JSON.parse((init?.body as string) || '{}');
        const id = `txn-${(++idCounter).toString().padStart(4, '0')}`;
        const row = { id, ...body };
        transcriptions.set(id, row);
        return new Response(JSON.stringify(row), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      if (method === 'PATCH') {
        const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
        const body = JSON.parse((init?.body as string) || '{}');
        const existing = idFilter ? transcriptions.get(idFilter) : undefined;
        if (existing) transcriptions.set(idFilter!, { ...existing, ...body });
        return new Response(JSON.stringify(existing ? [{ ...existing, ...body }] : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (method === 'DELETE') {
        const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
        const uidFilter = u.searchParams.get('user_id')?.replace(/^eq\./, '');
        const existing = idFilter ? transcriptions.get(idFilter) : undefined;
        if (existing && existing.user_id === uidFilter) {
          transcriptions.delete(idFilter!);
          return new Response(JSON.stringify([existing]), { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
        }
        return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
      }

      // GET (list or single)
      const idFilter = u.searchParams.get('id')?.replace(/^eq\./, '');
      const uidFilter = u.searchParams.get('user_id')?.replace(/^eq\./, '');
      let rows = Array.from(transcriptions.values());
      if (idFilter) rows = rows.filter((r) => r.id === idFilter);
      if (uidFilter) rows = rows.filter((r) => r.user_id === uidFilter);
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // STT gateway authorize hand-off (STT_API_KEY -> short-lived worker session token)
    if (url === 'https://gateway.test/stt/authorize') {
      authorizeCalls.count += 1;
      return new Response(JSON.stringify({ token: 'session-token', url: 'https://worker.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // worker-stt-prod
    if (url.startsWith('https://worker.test/v1/stt')) {
      const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
      workerCalls.push({ auth });
      if ('errorStatus' in sttWorkerResult) {
        return new Response(sttWorkerResult.body ?? 'worker error', { status: sttWorkerResult.errorStatus });
      }
      return new Response(JSON.stringify(sttWorkerResult), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return originalFetch(input, init);
  };
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

async function boot(opts: { presetUserId?: string } = {}) {
  const { sttRouter } = await import('./stt.js');

  const app = express();
  app.use(express.json());
  if (opts.presetUserId) {
    // Simulates requireAuthOrApiKey having already resolved an identity.
    app.use((req, _res, next) => { (req as express.Request & { userId?: string }).userId = opts.presetUserId; next(); });
  }
  app.use('/api/stt', sttRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stt`;

  const call = (token: string | null, method: string, path: string, body?: FormData) =>
    fetch(base + path, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    });

  return { call, server, close: () => { server.close(); } };
}

function buildAudioForm(opts: { mimetype?: string; bytes?: Buffer; language?: string; wordTimestamps?: boolean } = {}): FormData {
  const form = new FormData();
  const bytes = opts.bytes ?? Buffer.alloc(1024, 1);
  form.append('audio', new Blob([bytes], { type: opts.mimetype ?? 'audio/wav' }), 'audio.wav');
  if (opts.language) form.append('language', opts.language);
  if (opts.wordTimestamps) form.append('word_timestamps', 'true');
  return form;
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

function resetState() {
  transcriptions.clear();
  idCounter = 0;
  resolvedUserId = 'test-user-1';
  billingActive = true;
  sttWorkerResult = { text: 'hello world', language: 'en', duration: 3.5 };
  workerCalls.length = 0;
  authorizeCalls.count = 0;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call(null, 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('pre-resolved identity (bridge) without an active subscription -> 402, not skipped', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot({ presetUserId: resolvedUserId });
  const r = await s.call(null, 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 402);
  s.close();
  uninstallFetchMock();
});

test('invalid token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('bad-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('GET /transcriptions with no token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call(null, 'GET', '/transcriptions');
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Billing gate
// ---------------------------------------------------------------------------

test('billing inactive -> 402, no transcription row created', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 402);
  assert.equal(transcriptions.size, 0);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('missing audio file -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = new FormData();
  const r = await s.call('valid-token', 'POST', '/transcriptions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Audio file is required/);
  s.close();
  uninstallFetchMock();
});

test('empty/near-empty audio file -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ bytes: Buffer.alloc(10) }));
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

test('unsupported mimetype -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ mimetype: 'image/png' }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported audio format/);
  s.close();
  uninstallFetchMock();
});

test('invalid language hint -> 400', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ language: 'english' }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported language hint/);
  s.close();
  uninstallFetchMock();
});

test('valid ISO-639-1 language hint is accepted', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm({ language: 'en' }));
  assert.equal(r.status, 201);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Happy path — submits, authorizes against the gateway, calls the worker,
// persists the result, and reports usage.
// ---------------------------------------------------------------------------

test('create transcription authorizes with STT_API_KEY and returns the transcript', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.equal(body.status, 'done');
  assert.equal(body.text, 'hello world');
  assert.equal(body.language, 'en');
  assert.equal(authorizeCalls.count, 1);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].auth, 'Bearer session-token');
  s.close();
  uninstallFetchMock();
});

test('worker failure marks the row failed and returns 502', async () => {
  installFetchMock();
  resetState();
  sttWorkerResult = { errorStatus: 500, body: 'worker exploded' };
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.status, 'failed');
  s.close();
  uninstallFetchMock();
});

test('GET /transcriptions lists only the caller\'s own rows', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());

  resolvedUserId = 'test-user-2';
  const other = await boot();
  await other.call('valid-token', 'POST', '/transcriptions', buildAudioForm());

  const listRes = await s.call('valid-token', 'GET', '/transcriptions');
  const listBody = await listRes.json();
  assert.equal(listBody.transcriptions.length, 1);

  s.close();
  other.close();
  uninstallFetchMock();
});

test('GET /transcriptions/:id 404s for another user\'s row', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const { id } = await create.json();

  resolvedUserId = 'test-user-2';
  const r = await s.call('valid-token', 'GET', `/transcriptions/${id}`);
  assert.equal(r.status, 404);
  s.close();
  uninstallFetchMock();
});

test('DELETE /transcriptions/:id removes the row for its owner', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  const { id } = await create.json();

  const del = await s.call('valid-token', 'DELETE', `/transcriptions/${id}`);
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.deleted, true);
  assert.equal(transcriptions.has(id), false);
  s.close();
  uninstallFetchMock();
});

test('DELETE /transcriptions/:id 404s for a non-existent id', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const del = await s.call('valid-token', 'DELETE', '/transcriptions/does-not-exist');
  assert.equal(del.status, 404);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Rate limiting — the route caps each user at 20 transcriptions/hour
// (transcribeLimiter in stt.ts, keyed on req.userId).
// ---------------------------------------------------------------------------

test('rate limit trips after 20 transcriptions/hour for the same user', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  let last: Response | undefined;
  for (let i = 0; i < 21; i++) {
    last = await s.call('valid-token', 'POST', '/transcriptions', buildAudioForm());
  }
  assert.equal(last!.status, 429);
  s.close();
  uninstallFetchMock();
});
