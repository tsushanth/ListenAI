// npm test (node:test via tsx). Unit tests for voice-design routes.
// All external HTTP calls (Supabase + Modal) are intercepted via a patched global.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
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

async function boot() {
  const { voiceDesignRouter } = await import('./voiceDesign.js');

  const app = express();
  app.use('/api/voice-design', voiceDesignRouter);
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

  return { call, server, close: () => server.close() };
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
