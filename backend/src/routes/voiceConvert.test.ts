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

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
const modalJobs = new Map<string, { status: string; audio?: Buffer }>();
const modalRequests: Array<{ method: string; path: string }> = [];
const userConfigs = new Map<string, { modal_url: string; modal_secret: string }>();
let resolvedUserId = 'test-user-1';
let billingActive = true;

// ---------------------------------------------------------------------------
// Intercept fetch for Supabase and Modal backends
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

const MODAL_BASE = 'https://user-modal-app.modal.run';

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

  // Supabase REST — billing check
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

  // Supabase REST — user_voice_convert_configs (match any method/URL containing the table name)
  if (url.includes('/rest/v1/user_voice_convert_configs')) {
    const u = new URL(url);
    const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '');
    const method = (init?.method || 'GET').toUpperCase();

    if (method === 'GET') {
      const cfg = userConfigs.get(resolvedUserId);
      if (!cfg) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify([{ modal_url: cfg.modal_url, modal_secret: cfg.modal_secret }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'POST' || method === 'PUT') {
      const body = JSON.parse((init?.body as string) || '{}');
      if (body.user_id === resolvedUserId || (Array.isArray(body) && body[0]?.user_id === resolvedUserId)) {
        const record = Array.isArray(body) ? body[0] : body;
        userConfigs.set(resolvedUserId, { modal_url: record.modal_url, modal_secret: record.modal_secret });
        return new Response(JSON.stringify([record]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (body.modal_url && body.modal_secret) {
        userConfigs.set(resolvedUserId, { modal_url: body.modal_url, modal_secret: body.modal_secret });
        return new Response(JSON.stringify([body]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (method === 'DELETE' || method === 'PATCH') {
      if (uid === resolvedUserId) userConfigs.delete(resolvedUserId);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Supabase REST — voice_conversions (insert/update/delete)
  if (url.includes('/rest/v1/voice_conversions')) {
    return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Modal voice-convert backend (user's own Modal app)
  if (url.startsWith(MODAL_BASE)) {
    const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
    const cfg = userConfigs.get(resolvedUserId);
    if (cfg && !auth.includes(cfg.modal_secret)) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const path = url.replace(MODAL_BASE, '');

    if (path === '/convert' && (init?.method || '').toUpperCase() === 'POST') {
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
    if (deleteMatch && (init?.method || '').toUpperCase() === 'DELETE') {
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
  app.use(express.json());
  app.use('/api/voice-convert', voiceConvertRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-convert`;

  const call = (token: string | null, method: string, path: string, body?: FormData | object, isJson = false) =>
    fetch(base + path, {
      method,
      headers: token
        ? isJson
          ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
          : { Authorization: `Bearer ${token}` }
        : isJson
          ? { 'Content-Type': 'application/json' }
          : {},
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });

  return { call, server, close: () => { server.close(); } };
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
// Reset state before each test
// ---------------------------------------------------------------------------

function resetState() {
  modalJobs.clear();
  modalRequests.length = 0;
  userConfigs.clear();
  resolvedUserId = 'test-user-1';
  billingActive = true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call(null, 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
});

test('invalid token -> 401', async () => {
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('bad-token', 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
});

test('billing inactive -> 402', async () => {
  resetState();
  billingActive = false;
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 402);
  s.close();
});

test('no user config -> 400 with self-serve message', async () => {
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /not configured/);
  s.close();
});

test('missing consent statement -> 400', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /consent_statement/);
  s.close();
});

test('wrong consent statement -> 400', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'), 'I consent.');
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
});

test('missing source or target file -> 400', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = new FormData();
  form.append('consent_statement', CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
});

test('unsupported audio format -> 400', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
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

test('create conversion forwards to user Modal app and records job', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
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
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
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
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
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
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
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

// Config management tests

test('GET /config -> 404 when no config', async () => {
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'GET', '/config');
  assert.equal(r.status, 404);
  s.close();
});

test('POST /config saves user Modal endpoint', async () => {
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/config', {
    modal_url: 'https://my-app.modal.run',
    modal_secret: 'abc123',
  }, true);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.configured, true);
  assert.equal(body.modal_url, 'https://my-app.modal.run');

  const g = await s.call('valid-token', 'GET', '/config');
  assert.equal(g.status, 200);
  const getBody = await g.json();
  assert.equal(getBody.modal_url, 'https://my-app.modal.run');
  assert.equal(getBody.configured, true);
  assert.equal(getBody.modal_secret, undefined);
  s.close();
});

test('POST /config rejects non-https URL', async () => {
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'POST', '/config', {
    modal_url: 'http://insecure.com',
    modal_secret: 'abc',
  }, true);
  assert.equal(r.status, 400);
  s.close();
});

test('DELETE /config removes config', async () => {
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const r = await s.call('valid-token', 'DELETE', '/config');
  assert.equal(r.status, 200);
  assert.equal(userConfigs.has(resolvedUserId), false);
  s.close();
});

test('different user sees their own config', async () => {
  resetState();
  userConfigs.set('user-a', { modal_url: 'https://a.modal.run', modal_secret: 'secret-a' });
  userConfigs.set('user-b', { modal_url: 'https://b.modal.run', modal_secret: 'secret-b' });

  const s = await boot();

  resolvedUserId = 'user-a';
  const ra = await s.call('valid-token', 'GET', '/config');
  assert.equal(ra.status, 200);
  const bodyA = await ra.json();
  assert.equal(bodyA.modal_url, 'https://a.modal.run');

  resolvedUserId = 'user-b';
  const rb = await s.call('valid-token', 'GET', '/config');
  assert.equal(rb.status, 200);
  const bodyB = await rb.json();
  assert.equal(bodyB.modal_url, 'https://b.modal.run');

  resolvedUserId = 'user-c';
  const rc = await s.call('valid-token', 'GET', '/config');
  assert.equal(rc.status, 404);

  s.close();
});
