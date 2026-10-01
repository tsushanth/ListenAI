// npm test (node:test via tsx). Unit tests for voice-isolate routes.
// Mirrors voiceConvert.test.ts's pattern: all external HTTP calls (Supabase + Modal) are intercepted via a
// patched global.fetch; the modal CLI (deploy/secret-create/app-stop) is exec'd via child_process and is
// impractical to unit-test here without extensive exec mocking, so POST/DELETE /deploy stay covered by
// integration tests only, same as voiceConvert.test.ts's own note.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import '../lib/modalDeploymentsTestEnv.js'; // sets env before config loads (must precede the imports below)
import { makeHarness, type Harness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests } from '../lib/modalDeployments.js';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
const modalJobs = new Map<string, { status: string; vocals?: Buffer; instrumental?: Buffer }>();
const modalRequests: Array<{ method: string; path: string }> = [];
// The user's Modal deployment now lives in the deployment manager (lib/modalDeployments.ts). These tests seed a
// ready deployment through an in-memory store; `userConfigs` keeps the old set/get/delete/clear shape.
let harness: Harness = makeHarness();
setDeploymentManagerForTests(harness.manager);
const userConfigs = {
  set(userId: string, cfg: { modal_url: string; modal_secret: string }) {
    harness.store.removeLive(userId, 'isolate');
    harness.store.seedReady(userId, 'isolate', cfg.modal_url, cfg.modal_secret);
  },
  get(userId: string): { modal_url: string; modal_secret: string } | undefined {
    const r = harness.store.liveFor(userId, 'isolate');
    return r ? { modal_url: r.modal_url, modal_secret: r.modal_secret } : undefined;
  },
  delete(userId: string) { harness.store.removeLive(userId, 'isolate'); },
  clear() {
    harness = makeHarness();
    setDeploymentManagerForTests(harness.manager);
  },
};
let resolvedUserId = 'test-user-1';
let billingActive = true;

const MODAL_BASE = 'https://user-modal-app.modal.run';

let originalFetch: typeof globalThis.fetch;

function installFetchMock() {
  originalFetch = globalThis.fetch;
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

    // Supabase REST — voice_isolations (insert/update/delete)
    if (url.includes('/rest/v1/voice_isolations')) {
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Modal voice-isolate backend (user's own Modal app)
    if (url.startsWith(MODAL_BASE)) {
      const auth = (init?.headers as Record<string, string>)?.['Authorization'] || '';
      const cfg = userConfigs.get(resolvedUserId);
      if (cfg && !auth.includes(cfg.modal_secret)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }

      const u = new URL(url);
      const path = u.pathname;

      if (path === '/isolate' && (init?.method || '').toUpperCase() === 'POST') {
        modalRequests.push({ method: 'POST', path: '/isolate' });
        const id = `job-${Math.random().toString(36).slice(2, 10)}`;
        modalJobs.set(id, { status: 'queued' });
        return new Response(JSON.stringify({ job_id: id, status: 'queued', input_seconds: 12.4 }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }

      const pollMatch = path.match(/^\/isolate\/([^\/]+)$/);
      if (pollMatch && (init?.method || 'GET').toUpperCase() === 'GET') {
        const id = pollMatch[1];
        modalRequests.push({ method: 'GET', path: `/isolate/${id}` });
        const j = modalJobs.get(id);
        if (!j) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ job_id: id, status: j.status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const audioMatch = path.match(/^\/isolate\/([^\/]+)\/result$/);
      if (audioMatch) {
        const id = audioMatch[1];
        const stem = u.searchParams.get('stem') === 'instrumental' ? 'instrumental' : 'vocals';
        modalRequests.push({ method: 'GET', path: `/isolate/${id}/result?stem=${stem}` });
        const j = modalJobs.get(id);
        const audio = j?.[stem];
        if (!j || !audio) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }

      const deleteMatch = path.match(/^\/isolate\/([^\/]+)$/);
      if (deleteMatch && (init?.method || '').toUpperCase() === 'DELETE') {
        const id = deleteMatch[1];
        modalRequests.push({ method: 'DELETE', path: `/isolate/${id}` });
        modalJobs.delete(id);
        return new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
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

// `withGatewayAuth: true` mounts requireAuthOrApiKey in front of the router, exactly as
// backend/src/index.ts does in production — used to prove the MCP tool's gateway-forwarded-secret path
// actually authenticates against this route, not just the web app's own JWT path.
async function boot(opts: { withGatewayAuth?: boolean } = {}) {
  const { voiceIsolateRouter } = await import('./voiceIsolate.js');
  const app = express();
  app.use(express.json());
  if (opts.withGatewayAuth) {
    const { requireAuthOrApiKey } = await import('../middleware/apiKeyAuth.js');
    app.use('/api/voice-isolate', requireAuthOrApiKey, voiceIsolateRouter);
  } else {
    app.use('/api/voice-isolate', voiceIsolateRouter);
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-isolate`;

  const call = (headers: Record<string, string> | null, method: string, path: string, body?: FormData) =>
    fetch(base + path, { method, headers: headers ?? {}, body });

  return { call, server, close: () => { server.close(); } };
}

function buildForm(input: Buffer, opts: { consent?: string; wantInstrumental?: boolean; mime?: string } = {}): FormData {
  const form = new FormData();
  form.append('input', new Blob([input], { type: opts.mime ?? 'audio/wav' }), 'input.wav');
  if (opts.consent) form.append('consent_statement', opts.consent);
  if (opts.wantInstrumental !== undefined) form.append('want_instrumental', String(opts.wantInstrumental));
  return form;
}

const CONSENT_STATEMENT =
  'I confirm that I have the legal right to use this audio and that isolating its vocal ' +
  'track does not infringe anyone else\'s rights.';

function resetState() {
  modalJobs.clear();
  modalRequests.length = 0;
  userConfigs.clear();
  resolvedUserId = 'test-user-1';
  billingActive = true;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

test('no token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call(null, 'POST', '/isolations', form);
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('invalid token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ Authorization: 'Bearer bad-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('gateway-forwarded API key identity (no JWT) is accepted when mounted behind requireAuthOrApiKey', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': resolvedUserId }, 'POST', '/isolations', form);
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.ok(body.job_id);
  s.close();
  uninstallFetchMock();
});

test('gateway-forwarded request with the wrong secret is rejected (401), never reaches the billing/Modal gate', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ 'x-gateway-admin-secret': 'wrong-secret', 'x-gateway-uid': resolvedUserId }, 'POST', '/isolations', form);
  assert.equal(r.status, 401);
  assert.equal(modalRequests.length, 0);
  s.close();
  uninstallFetchMock();
});

test('gateway-forwarded identity without an active subscription -> 402 (bridge must not skip the billing gate)', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': resolvedUserId }, 'POST', '/isolations', form);
  assert.equal(r.status, 402);
  assert.equal(modalRequests.length, 0);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Billing gate
// ---------------------------------------------------------------------------

test('billing inactive -> 402', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot();
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 402);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

test('no user deployment or global fallback -> 400 with self-serve message', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('input'), { consent: CONSENT_STATEMENT });
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /not configured/);
  s.close();
  uninstallFetchMock();
});

test('missing input file -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = new FormData();
  form.append('consent_statement', CONSENT_STATEMENT);
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /input audio file/);
  s.close();
  uninstallFetchMock();
});

test('unsupported input format -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('fake'), { consent: CONSENT_STATEMENT, mime: 'image/png' });
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Unsupported input format/);
  s.close();
  uninstallFetchMock();
});

test('missing consent statement -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('input'));
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /consent_statement/);
  s.close();
  uninstallFetchMock();
});

test('paraphrased (non-verbatim) consent statement -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('input'), { consent: 'I consent to this.' });
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('submit isolation forwards to user Modal app and records job', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  modalRequests.length = 0;
  const form = buildForm(Buffer.from('fake-input'), { consent: CONSENT_STATEMENT, wantInstrumental: true });
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  assert.equal(r.status, 202);
  const json = await r.json();
  assert.ok(json.job_id);
  assert.equal(json.status, 'queued');
  assert.equal(modalRequests[modalRequests.length - 1]?.method, 'POST');
  s.close();
  uninstallFetchMock();
});

test('poll isolation returns Modal status', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('fake-input'), { consent: CONSENT_STATEMENT });
  const create = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'done', vocals: Buffer.from('fake-vocals-wav') });

  const poll = await s.call({ Authorization: 'Bearer valid-token' }, 'GET', `/isolations/${job_id}`);
  assert.equal(poll.status, 200);
  const body = await poll.json();
  assert.equal(body.status, 'done');
  s.close();
  uninstallFetchMock();
});

test('fetch audio defaults to the vocals stem', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('fake-input'), { consent: CONSENT_STATEMENT });
  const create = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'done', vocals: Buffer.from('fake-vocals-wav'), instrumental: Buffer.from('fake-instrumental-wav') });

  const audio = await s.call({ Authorization: 'Bearer valid-token' }, 'GET', `/isolations/${job_id}/audio`);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.equal(bytes.toString(), 'fake-vocals-wav');
  s.close();
  uninstallFetchMock();
});

test('fetch audio with ?stem=instrumental returns the other stem', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('fake-input'), { consent: CONSENT_STATEMENT });
  const create = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  const { job_id } = await create.json();

  modalJobs.set(job_id, { status: 'done', vocals: Buffer.from('fake-vocals-wav'), instrumental: Buffer.from('fake-instrumental-wav') });

  const audio = await s.call({ Authorization: 'Bearer valid-token' }, 'GET', `/isolations/${job_id}/audio?stem=instrumental`);
  assert.equal(audio.status, 200);
  const bytes = Buffer.from(await audio.arrayBuffer());
  assert.equal(bytes.toString(), 'fake-instrumental-wav');
  s.close();
  uninstallFetchMock();
});

test('delete isolation removes job', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('fake-input'), { consent: CONSENT_STATEMENT });
  const create = await s.call({ Authorization: 'Bearer valid-token' }, 'POST', '/isolations', form);
  const { job_id } = await create.json();

  const del = await s.call({ Authorization: 'Bearer valid-token' }, 'DELETE', `/isolations/${job_id}`);
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.deleted, true);
  s.close();
  uninstallFetchMock();
});

// Deployment management (GET/POST/DELETE /deploy)

test('GET /deploy -> 404 when no deployment', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'GET', '/deploy');
  assert.equal(r.status, 404);
  s.close();
  uninstallFetchMock();
});

test('GET /deploy returns deployment info, never the secret', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: 'https://my-isolate-app.modal.run', modal_secret: 'secret123' });
  const s = await boot();
  const r = await s.call({ Authorization: 'Bearer valid-token' }, 'GET', '/deploy');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.modal_url, 'https://my-isolate-app.modal.run');
  assert.equal(body.status, 'ready');
  assert.equal(body.modal_secret, undefined);
  s.close();
  uninstallFetchMock();
});

// POST /deploy and DELETE /deploy shell out to the modal CLI (child_process.exec) and are impractical to
// unit-test here without extensive exec mocking — same call as voiceConvert.test.ts makes for its own
// deploy/destroy endpoints. Covered by integration tests instead.
