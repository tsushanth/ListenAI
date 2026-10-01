// npm test (node:test via tsx). Unit tests for voice-convert routes.
// All external HTTP calls (Supabase + Modal) are intercepted via a patched global.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import '../lib/modalDeploymentsTestEnv.js'; // sets env before config loads (must precede the imports below)
import { makeHarness, type Harness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests } from '../lib/modalDeployments.js';
import { setUsageRecorderForTests, type UsageEventInput } from '../lib/modalUsage.js';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
const modalJobs = new Map<string, { status: string; audio?: Buffer; gpu_seconds?: number }>();
const modalRequests: Array<{ method: string; path: string }> = [];
// The user's Modal deployment now lives in the deployment manager (lib/modalDeployments.ts). These tests seed a
// ready deployment through an in-memory store; `userConfigs` keeps the old set/get/delete/clear shape.
let harness: Harness = makeHarness();
setDeploymentManagerForTests(harness.manager);
const userConfigs = {
  set(userId: string, cfg: { modal_url: string; modal_secret: string }) {
    harness.store.removeLive(userId, 'convert');
    harness.store.seedReady(userId, 'convert', cfg.modal_url, cfg.modal_secret);
  },
  get(userId: string): { modal_url: string; modal_secret: string } | undefined {
    const r = harness.store.liveFor(userId, 'convert');
    return r ? { modal_url: r.modal_url, modal_secret: r.modal_secret } : undefined;
  },
  delete(userId: string) { harness.store.removeLive(userId, 'convert'); },
  clear() {
    harness = makeHarness();
    setDeploymentManagerForTests(harness.manager);
  },
};
let resolvedUserId = 'test-user-1';
let billingActive = true;

// ---------------------------------------------------------------------------
// Intercept fetch — installed per-test so concurrent test files aren't affected
// ---------------------------------------------------------------------------
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

      const pollMatch = path.match(/^\/convert\/([^\/]+)$/);
      if (pollMatch) {
        const id = pollMatch[1];
        modalRequests.push({ method: 'GET', path: `/convert/${id}` });
        const j = modalJobs.get(id);
        if (!j) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ job_id: id, status: j.status, ...(j.gpu_seconds !== undefined ? { gpu_seconds: j.gpu_seconds } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      const audioMatch = path.match(/^\/convert\/([^\/]+)\/result$/);
      if (audioMatch) {
        const id = audioMatch[1];
        modalRequests.push({ method: 'GET', path: `/convert/${id}/result` });
        const j = modalJobs.get(id);
        if (!j || !j.audio) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        return new Response(j.audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
      }

      const deleteMatch = path.match(/^\/convert\/([^\/]+)$/);
      if (deleteMatch && (init?.method || '').toUpperCase() === 'DELETE') {
        const id = deleteMatch[1];
        modalRequests.push({ method: 'DELETE', path: `/convert/${id}` });
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

// `withGatewayAuth: true` mounts requireAuthOrApiKey in front of the router, exactly as backend/src/index.ts
// does in production (API-key / MCP callers and the web app's JWT both go through it).
async function boot(opts: { withGatewayAuth?: boolean } = {}) {
  const { voiceConvertRouter } = await import('./voiceConvert.js');

  const app = express();
  app.use(express.json());
  if (opts.withGatewayAuth) {
    const { requireAuthOrApiKey } = await import('../middleware/apiKeyAuth.js');
    app.use('/api/voice-convert', requireAuthOrApiKey, voiceConvertRouter);
  } else {
    app.use('/api/voice-convert', voiceConvertRouter);
  }
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

  const callH = (headers: Record<string, string>, method: string, path: string, body?: FormData) =>
    fetch(base + path, { method, headers, body });

  return { call, callH, server, close: () => { server.close(); } };
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
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call(null, 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('invalid token -> 401', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('bad-token', 'POST', '/conversions', form);
  assert.equal(r.status, 401);
  s.close();
  uninstallFetchMock();
});

test('billing inactive -> 402', async () => {
  installFetchMock();
  resetState();
  billingActive = false;
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 402);
  s.close();
  uninstallFetchMock();
});

test('no user deployment -> 400 with self-serve message', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /not configured/);
  s.close();
  uninstallFetchMock();
});

test('missing consent statement -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'));
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /consent_statement/);
  s.close();
  uninstallFetchMock();
});

test('wrong consent statement -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = buildForm(Buffer.from('src'), Buffer.from('tgt'), 'I consent.');
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

test('missing source or target file -> 400', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot();
  const form = new FormData();
  form.append('consent_statement', CONSENT_STATEMENT);
  const r = await s.call('valid-token', 'POST', '/conversions', form);
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

test('unsupported audio format -> 400', async () => {
  installFetchMock();
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
  uninstallFetchMock();
});

test('create conversion forwards to user Modal app and records job', async () => {
  installFetchMock();
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
  uninstallFetchMock();
});

test('poll conversion returns Modal status', async () => {
  installFetchMock();
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
  uninstallFetchMock();
});

test('fetch audio returns wav bytes', async () => {
  installFetchMock();
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
  uninstallFetchMock();
});

test('delete conversion removes job', async () => {
  installFetchMock();
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
  uninstallFetchMock();
});

// Deployment management tests (replaces old /config tests)

test('GET /deploy -> 404 when no deployment', async () => {
  installFetchMock();
  resetState();
  const s = await boot();
  const r = await s.call('valid-token', 'GET', '/deploy');
  assert.equal(r.status, 404);
  s.close();
  uninstallFetchMock();
});

test('GET /deploy returns deployment info when configured', async () => {
  installFetchMock();
  resetState();
  userConfigs.set(resolvedUserId, { modal_url: 'https://my-app.modal.run', modal_secret: 'secret123' });
  const s = await boot();
  const r = await s.call('valid-token', 'GET', '/deploy');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.modal_url, 'https://my-app.modal.run');
  assert.equal(body.status, 'ready');
  assert.equal(body.modal_secret, undefined); // should never leak secret
  s.close();
  uninstallFetchMock();
});

// Deployment tests: POST /deploy and DELETE /deploy do subprocess calls to modal CLI,
// which is impractical to unit-test here without extensive exec mocking. Covered by
// integration tests instead.

// ---------------------------------------------------------------------------
// API-key (gateway-forwarded identity) auth, mounted behind requireAuthOrApiKey
// ---------------------------------------------------------------------------

const GW = () => ({ 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': resolvedUserId });

test('gateway-forwarded API key identity can submit, poll and fetch a conversion', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-1'; // own rate-limit bucket (10/hour per user)
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const r = await s.callH(GW(), 'POST', '/conversions', buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT));
  assert.equal(r.status, 202);
  const { job_id } = await r.json();
  assert.ok(job_id);
  modalJobs.set(job_id, { status: 'done', audio: Buffer.from('fake-wav') });
  assert.equal((await s.callH(GW(), 'GET', `/conversions/${job_id}`)).status, 200);
  const audio = await s.callH(GW(), 'GET', `/conversions/${job_id}/audio`);
  assert.equal(audio.status, 200);
  s.close();
  uninstallFetchMock();
});

test('gateway-forwarded request with the wrong secret -> 401 and never reaches Modal', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-2'; // own rate-limit bucket (10/hour per user)
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const r = await s.callH({ 'x-gateway-admin-secret': 'wrong', 'x-gateway-uid': resolvedUserId }, 'POST', '/conversions',
    buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT));
  assert.equal(r.status, 401);
  assert.equal(modalRequests.length, 0);
  s.close();
  uninstallFetchMock();
});

test('billing is still enforced for a gateway-forwarded identity (no free ride via the bridge)', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-3'; // own rate-limit bucket (10/hour per user)
  billingActive = false;
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const r = await s.callH(GW(), 'POST', '/conversions', buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT));
  assert.equal(r.status, 402);
  assert.equal(modalRequests.length, 0);
  s.close();
  uninstallFetchMock();
});

test('consent statement is still required for gateway-forwarded callers', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-4'; // own rate-limit bucket (10/hour per user)
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  const s = await boot({ withGatewayAuth: true });
  const r = await s.callH(GW(), 'POST', '/conversions', buildForm(Buffer.from('src'), Buffer.from('tgt'), 'I consent.'));
  assert.equal(r.status, 400);
  s.close();
  uninstallFetchMock();
});

test('no deployment -> 400 with machine-readable code deployment_required (API-key callers deploy via POST /deploy)', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-5'; // own rate-limit bucket (10/hour per user)
  const s = await boot({ withGatewayAuth: true });
  const r = await s.callH(GW(), 'POST', '/conversions', buildForm(Buffer.from('src'), Buffer.from('tgt'), CONSENT_STATEMENT));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'deployment_required');
  s.close();
  uninstallFetchMock();
});

test('GET /deploy works for gateway-forwarded callers (404 when none)', async () => {
  installFetchMock();
  resetState();
  resolvedUserId = 'gw-user-6'; // own rate-limit bucket (10/hour per user)
  const s = await boot({ withGatewayAuth: true });
  assert.equal((await s.callH(GW(), 'GET', '/deploy')).status, 404);
  s.close();
  uninstallFetchMock();
});


// ---------------------------------------------------------------------------
// Shadow-mode usage recording: the GPU seconds the worker measured for a job
// ---------------------------------------------------------------------------

function captureUsage() {
  const events: UsageEventInput[] = [];
  const seen = new Set<string>(); // mimics the database function: idempotent per (service, job_id)
  setUsageRecorderForTests({
    record: async (ev) => {
      events.push(ev);
      const key = `${ev.service}:${ev.jobId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  });
  return events;
}

test('polling a finished job records its measured GPU seconds against the deployment, for done and failed jobs', async () => {
  installFetchMock();
  resetState();
  const events = captureUsage();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  modalJobs.set('job-done', { status: 'done', gpu_seconds: 12.5 });
  modalJobs.set('job-failed', { status: 'failed', gpu_seconds: 3 });
  modalJobs.set('job-running', { status: 'processing' });
  const s = await boot();

  assert.equal((await s.call('valid-token', 'GET', '/conversions/job-done')).status, 200);
  assert.equal((await s.call('valid-token', 'GET', '/conversions/job-failed')).status, 200);
  assert.equal((await s.call('valid-token', 'GET', '/conversions/job-running')).status, 200);

  const dep = harness.store.liveFor(resolvedUserId, 'convert');
  assert.deepEqual(
    events.map((e) => [e.jobId, e.gpuSeconds, e.service, e.deploymentId]),
    [['job-done', 12.5, 'convert', dep?.id], ['job-failed', 3, 'convert', dep?.id]],
    'finished jobs are recorded; a job still running is not',
  );
  s.close();
  setUsageRecorderForTests(null);
  uninstallFetchMock();
});

test('re-polling a finished job is reported again but counted once (idempotent per job)', async () => {
  installFetchMock();
  resetState();
  const events = captureUsage();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  modalJobs.set('job-once', { status: 'done', gpu_seconds: 7 });
  const s = await boot();
  for (let i = 0; i < 3; i++) await s.call('valid-token', 'GET', '/conversions/job-once');
  assert.equal(events.length, 3, 'the route reports each poll');
  let counted = 0;
  const seen = new Set<string>();
  for (const e of events) { if (!seen.has(e.jobId)) { seen.add(e.jobId); counted++; } }
  assert.equal(counted, 1, 'the database function keeps it to one');
  s.close();
  setUsageRecorderForTests(null);
  uninstallFetchMock();
});

test('a job status without gpu_seconds records nothing', async () => {
  installFetchMock();
  resetState();
  const events = captureUsage();
  userConfigs.set(resolvedUserId, { modal_url: MODAL_BASE, modal_secret: 'my-secret' });
  modalJobs.set('job-nogpu', { status: 'done' });
  const s = await boot();
  await s.call('valid-token', 'GET', '/conversions/job-nogpu');
  assert.equal(events.length, 0);
  s.close();
  setUsageRecorderForTests(null);
  uninstallFetchMock();
});
