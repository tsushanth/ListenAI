// npm test (node:test via tsx). Unit tests for voice-convert routes.
// All external HTTP calls (Supabase + Modal) are intercepted via a patched global.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.VOICE_CONVERT_URL = 'http://127.0.0.1:9998';
process.env.VOICE_CONVERT_SECRET = 'modal-secret';

// ---------------------------------------------------------------------------
// Mock Modal backend state
// ---------------------------------------------------------------------------
const modalJobs = new Map<string, { status: string; audio?: Buffer }>();
const modalRequests: Array<{ method: string; path: string }> = [];

// ---------------------------------------------------------------------------
// Intercept fetch for Supabase and Modal backends
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;
let resolvedUserId = 'test-user-1';
let billingActive = true;

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

  // Modal voice-convert backend
  if (url.startsWith('http://127.0.0.1:9998/')) {
    const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
    if (!auth.includes('modal-secret')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const path = url.replace('http://127.0.0.1:9998', '');

    if (path === '/convert' && init?.method === 'POST') {
      modalRequests.push({ method: 'POST', path: '/convert' });
      const id = `job-${Math.random().toString(36).slice(2, 10)}`;
      modalJobs.set(id, { status: 'queued' });
      return new Response(JSON.stringify({ job_id: id, status: 'queued', source_seconds: 5.2, target_seconds: 3.1 }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }

    const pollMatch = path.match(/^\/convert\/([^/]+)$/);
    if (pollMatch) {
      const id = pollMatch[1];
      modalRequests.push({ method: 'GET', path: `/convert/${id}` });
      const j = modalJobs.get(id);
      if (!j) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ job_id: id, status: j.status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const audioMatch = path.match(/^\/convert\/([^/]+)\/result$/);
    if (audioMatch) {
      const id = audioMatch[1];
      modalRequests.push({ method: 'GET', path: `/convert/${id}/result` });
      const j = modalJobs.get(id);
      if (!j || !j.audio) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(j.audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    }

    const deleteMatch = path.match(/^\/convert\/([^/]+)$/);
    if (deleteMatch && init?.method === 'DELETE') {
      const id = deleteMatch[1];
      modalRequests.push({ method: 'DELETE', path: `/convert/${id}` });
      modalJobs.delete(id);
      return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

async function boot() {
  const { voiceConvertRouter } = await import('./voiceConvert.js');

  const app = express();
  app.use('/api/voice-convert', voiceConvertRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-convert`;

  const call = (token: string | null, method: string, path: string, body?: FormData) =>
    fetch(base + path, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: body ?? undefined,
    });

  return { call, server, close: () => server.close() };
}

function buildForm(source: Buffer, target: Buffer, consent?: string): FormData {
  const form = new FormData();
  form.append('source', new Blob([source], { type: 'audio/wav' }), 'source.wav');
  form.append('target', new Blob([target], { type: 'audio/wav' }), 'target.wav');
  if (consent) form.append('consent_statement', consent);
  return form;
}

const CONSENT_STATEMENT =
  'I confirm that I have the legal right to use both the source audio and the target voice reference, ' +
  'and that this conversion does not impersonate any person without their consent.';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call(null, 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
});

test('invalid token -> 401', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('bad-token', 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
});

test('billing inactive -> 402', async () => {
  const s = await boot();
  billingActive = false;
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 402);
  billingActive = true;
  s.close();
});

test('missing consent statement -> 400', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /consent_statement/);
  s.close();
});

test('wrong consent statement -> 400', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'), 'I consent.');
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
});

test('missing source or target file -> 400', async () => {
  const s = await boot();
  const form = new FormData();
  form.append('consent_statement', CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
});

test('unsupported audio format -> 400', async () => {
  const s = await boot();
  const form = new FormData();
  form.append('source', new Blob([Buffer.from('fake')], { type: 'image/png' }), 'source.png');
  form.append('target', new Blob([Buffer.from('fake')], { type: 'audio/wav' }), 'target.wav');
  form.append('consent_statement', CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported source format/);
  s.close();
});

test('create conversion forwards to Modal and records job', async () => {
  const s = await boot();
  modalRequests.length = 0;
  const form = buildForm(Buffer.from('fake-source'), Buffer.from('fake-target'), CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 202);
  const json = await r.json();
  assert.ok(json.job_id);
  assert.equal(json.status, 'queued');
  assert.equal(modalRequests[modalRequests.length - 1]?.method, 'POST');
  s.close();
});

test('poll conversion returns Modal status', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('fake-source'), Buffer.from('fake-target'), CONSENT_STATEMENT);
  const create = await s.call('valid-token', 'POST', '/conversions', form);
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'done', audio: Buffer.from('fake-wav') });

  const poll = await s.call('valid-token', 'GET', `/conversions/${job_id}`);
  assert.equal(poll.status, 200);
  const body = await poll.json();
  assert.equal(body.status, 'done');
  s.close();
});

test('fetch audio returns wav bytes', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('fake-source'), Buffer.from('fake-target'), CONSENT_STATEMENT);
  const create = await s.call('valid-token', 'POST', '/conversions', form);
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'done', audio: Buffer.from('fake-wav') });

  const audio = await s.call('valid-token', 'GET', `/conversions/${job_id}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  s.close();
});

test('delete conversion removes job', async () => {
  const s = await boot();
  const form = buildForm(Buffer.from('fake-source'), Buffer.from('fake-target'), CONSENT_STATEMENT);
  const create = await s.call('valid-token', 'POST', '/conversions', form);
  const { job_id } = await create.json();

  const del = await s.call('valid-token', 'DELETE', `/conversions/${job_id}`);
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.deleted, true);
  s.close();
});
