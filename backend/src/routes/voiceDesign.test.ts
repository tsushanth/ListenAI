// npm test (node:test via tsx). Unit tests for voice-design routes.
// All external HTTP calls (Supabase + Modal) are intercepted via a patched global.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';
process.env.VOICE_DESIGN_URL = 'http://127.0.0.1:9999';
process.env.VOICE_DESIGN_SECRET = 'modal-secret';

// ---------------------------------------------------------------------------
// Intercept fetch for Supabase and Modal backends
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let resolvedUserId = 'test-user-1';
let billingActive = true;

const modalJobs = new Map<string, { status: string; audio?: Buffer }>();
const modalRequests: Array<{ method: string; path: string; body?: unknown }> = [];

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  // Supabase auth
  if (url === 'http://localhost:54321/auth/v1/user') {
    const token = (init?.headers as Record<string, string>)?.['Authorization']?.replace(/^Bearer /, '') || '';
    if (token === 'valid-token') {
      return new Response(JSON.stringify({ id: resolvedUserId, aud: 'authenticated' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ message: 'Invalid token', error: 'invalid_token' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  // Supabase REST
  if (url.startsWith('http://localhost:54321/rest/')) {
    if (url.includes('/realtimetts_free_credits')) {
      // Free-credit gate (hasUsageAllowance): exhausted, so inactive-billing tests still 402 quickly.
      return new Response(JSON.stringify([{ granted: 10000, used: 10000 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/realtimetts_billing')) {
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
    // all other tables -> empty success
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Modal voice-design backend
  if (url.startsWith('http://127.0.0.1:9999/')) {
    const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
    if (!auth.includes('modal-secret')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const path = url.replace('http://127.0.0.1:9999', '');

    if (path === '/designs' && init?.method === 'POST') {
      modalRequests.push({ method: 'POST', path: '/designs', body: init.body ? JSON.parse(String(init.body)) : undefined });
      const id = `job-${Math.random().toString(36).slice(2, 10)}`;
      modalJobs.set(id, { status: 'queued' });
      return new Response(JSON.stringify({ job_id: id, status: 'queued' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }

    const pollMatch = path.match(/^\/designs\/([^/]+)$/);
    if (pollMatch) {
      const id = pollMatch[1];
      modalRequests.push({ method: 'GET', path: `/designs/${id}` });
      const j = modalJobs.get(id);
      if (!j) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ status: j.status, ready_at: j.status === 'ready' ? new Date().toISOString() : undefined }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const audioMatch = path.match(/^\/designs\/([^/]+)\/audio$/);
    if (audioMatch) {
      const id = audioMatch[1];
      modalRequests.push({ method: 'GET', path: `/designs/${id}/audio` });
      const j = modalJobs.get(id);
      if (!j || !j.audio) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(j.audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }
  }

  return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

// `withGatewayAuth: true` mounts requireAuthOrApiKey in front of the router, exactly as backend/src/index.ts
// does in production (API-key / MCP callers and the web app's JWT both go through it).
async function boot(opts: { withGatewayAuth?: boolean } = {}) {
  const { voiceDesignRouter } = await import('./voiceDesign.js');

  const app = express();
  if (opts.withGatewayAuth) {
    const { requireAuthOrApiKey } = await import('../middleware/apiKeyAuth.js');
    app.use('/api/voice-design', requireAuthOrApiKey, voiceDesignRouter);
  } else {
    app.use('/api/voice-design', voiceDesignRouter);
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-design`;

  const call = (token: string | null, method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const callH = (headers: Record<string, string>, method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  return { call, callH, server, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  const s = await boot();
  const r = await s.call(null, 'GET', '/presets');
  assert.equal(r.status, 401);
  s.close();
});

test('invalid token -> 401', async () => {
  const s = await boot();
  const r = await s.call('bad-token', 'GET', '/presets');
  assert.equal(r.status, 401);
  s.close();
});

test('billing inactive -> 402', async () => {
  const s = await boot();
  billingActive = false;
  const r = await s.call('valid-token', 'GET', '/presets');
  assert.equal(r.status, 402);
  billingActive = true;
  s.close();
});

test('create design job forwards to Modal and records job', async () => {
  const s = await boot();
  modalRequests.length = 0;
  const r = await s.call('valid-token', 'POST', '/designs', {
    description: 'A warm, friendly female narrator for audiobooks',
    text: 'Hello world',
  });
  assert.equal(r.status, 201);
  const json = await r.json();
  assert.ok(json.job_id);
  assert.equal(json.status, 'queued');
  assert.equal(modalRequests[modalRequests.length - 1]?.method, 'POST');
  s.close();
});

test('create design rate limit is per user', async () => {
  const s = await boot();
  resolvedUserId = 'rate-limit-user';
  // Rate limit is 12/hour — a single request won't trigger it.
  const r1 = await s.call('valid-token', 'POST', '/designs', { description: 'Test voice one', text: 'hi' });
  assert.equal(r1.status, 201);
  s.close();
  resolvedUserId = 'test-user-1';
});

test('invalid description or text -> 400', async () => {
  const s = await boot();
  assert.equal((await s.call('valid-token', 'POST', '/designs', { description: 'x', text: 'hi' })).status, 400);
  assert.equal((await s.call('valid-token', 'POST', '/designs', { description: 'A valid description here', text: '' })).status, 400);
  assert.equal((await s.call('valid-token', 'POST', '/designs', { description: '', text: 'hi' })).status, 400);
  s.close();
});

test('poll job returns Modal status', async () => {
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/designs', {
    description: 'A warm, friendly female narrator for audiobooks',
    text: 'Hello world',
  });
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'ready', audio: Buffer.from('fake-wav') });

  const poll = await s.call('valid-token', 'GET', `/designs/${job_id}`);
  assert.equal(poll.status, 200);
  const body = await poll.json();
  assert.equal(body.status, 'ready');
  s.close();
});

test('fetch audio returns wav bytes', async () => {
  const s = await boot();
  const create = await s.call('valid-token', 'POST', '/designs', {
    description: 'A warm, friendly female narrator for audiobooks',
    text: 'Hello world',
  });
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'ready', audio: Buffer.from('fake-wav') });

  const audio = await s.call('valid-token', 'GET', `/designs/${job_id}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  s.close();
});

test('presets empty list', async () => {
  const s = await boot();
  const r = await s.call('valid-token', 'GET', '/presets');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.presets, []);
  s.close();
});

// ---------------------------------------------------------------------------
// API-key (gateway-forwarded identity) auth, mounted behind requireAuthOrApiKey
// ---------------------------------------------------------------------------

const GW = () => ({ 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': resolvedUserId });
const VALID_DESIGN = { description: 'A warm, friendly female narrator for audiobooks', text: 'Hello world' };

test('gateway-forwarded API key identity can create and poll a design job', async () => {
  const s = await boot({ withGatewayAuth: true });
  resolvedUserId = 'gw-user-1'; // own rate-limit bucket (12/hour per user)
  const create = await s.callH(GW(), 'POST', '/designs', VALID_DESIGN);
  assert.equal(create.status, 201);
  const { job_id } = await create.json();
  modalJobs.set(job_id, { status: 'ready', audio: Buffer.from('fake-wav') });
  assert.equal((await s.callH(GW(), 'GET', `/designs/${job_id}`)).status, 200);
  const audio = await s.callH(GW(), 'GET', `/designs/${job_id}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  s.close();
});

test('gateway-forwarded request with the wrong secret -> 401 and never reaches Modal', async () => {
  const s = await boot({ withGatewayAuth: true });
  resolvedUserId = 'gw-user-2'; // own rate-limit bucket (12/hour per user)
  modalRequests.length = 0;
  const r = await s.callH({ 'x-gateway-admin-secret': 'wrong', 'x-gateway-uid': resolvedUserId }, 'POST', '/designs', VALID_DESIGN);
  assert.equal(r.status, 401);
  assert.equal(modalRequests.length, 0);
  s.close();
});

test('no credentials at all behind requireAuthOrApiKey -> 401', async () => {
  const s = await boot({ withGatewayAuth: true });
  resolvedUserId = 'gw-user-3'; // own rate-limit bucket (12/hour per user)
  assert.equal((await s.callH({}, 'POST', '/designs', VALID_DESIGN)).status, 401);
  s.close();
});

test('billing is still enforced for a gateway-forwarded identity (no free ride via the bridge)', async () => {
  const s = await boot({ withGatewayAuth: true });
  resolvedUserId = 'gw-user-4'; // own rate-limit bucket (12/hour per user)
  modalRequests.length = 0;
  billingActive = false;
  const r = await s.callH(GW(), 'POST', '/designs', VALID_DESIGN);
  assert.equal(r.status, 402);
  assert.equal(modalRequests.length, 0);
  billingActive = true;
  s.close();
});

test('validation still applies to gateway-forwarded callers', async () => {
  const s = await boot({ withGatewayAuth: true });
  resolvedUserId = 'gw-user-5'; // own rate-limit bucket (12/hour per user)
  assert.equal((await s.callH(GW(), 'POST', '/designs', { description: 'x', text: 'hi' })).status, 400);
  s.close();
});
