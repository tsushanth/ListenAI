// npm test (node:test via tsx). HTTP behaviour of the shared deploy / status / teardown endpoints, driven by an
// in-memory store and fake Modal CLI (no Modal, no Supabase).
import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import '../lib/modalDeploymentsTestEnv.js'; // must precede the imports below: sets env before config loads
import { makeHarness, type Harness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests, type DeploymentService } from '../lib/modalDeployments.js';
import { mountDeploymentRoutes, createDeploymentsListRouter } from './deployments.js';

// Stand-in for each feature's requireUser: identity comes from a header.
function asUser(req: Request, res: Response, next: NextFunction) {
  const u = req.header('x-test-user');
  if (!u) { res.status(401).json({ error: 'Sign in required.' }); return; }
  (req as Request & { userId?: string }).userId = u;
  next();
}

async function boot(service: DeploymentService = 'convert', limits: Parameters<typeof makeHarness>[0] = {}) {
  const h: Harness = makeHarness(limits);
  setDeploymentManagerForTests(h.manager);
  const app = express();
  app.use(express.json());
  const r = express.Router();
  mountDeploymentRoutes(r, service, asUser);
  app.use('/feature', r);
  const list = createDeploymentsListRouter();
  app.use('/api/deployments', asUser, list);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, user: string | null = 'user-a') => {
    const res = await fetch(base + path, { method, headers: user ? { 'x-test-user': user } : {} });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : null };
  };
  return { h, call, close: () => { server.close(); setDeploymentManagerForTests(null); } };
}

test('POST /deploy returns 202 immediately, then GET shows it ready; the secret is never in any response', async () => {
  const { h, call, close } = await boot();
  const post = await call('POST', '/feature/deploy');
  assert.equal(post.status, 202);
  assert.equal(post.body.status, 'requested');
  assert.equal(post.body.service, 'convert');

  await h.manager.whenIdle();
  const get = await call('GET', '/feature/deploy');
  assert.equal(get.status, 200);
  assert.equal(get.body.status, 'ready');
  assert.match(get.body.modal_url, /^https:\/\/test-ws--voice-convert-dev-user-/);
  assert.equal(typeof get.body.seconds_until_auto_teardown, 'number');

  const secret = [...h.store.rows.values()][0].modal_secret;
  assert.ok(secret.length >= 8);
  for (const text of [post.text, get.text]) assert.equal(text.includes(secret), false, 'secret leaked in a response');
  assert.equal('modal_secret' in get.body, false);
  close();
});

test('POST /deploy twice returns 409 with the existing deployment', async () => {
  const { h, call, close } = await boot();
  await call('POST', '/feature/deploy');
  await h.manager.whenIdle();
  const again = await call('POST', '/feature/deploy');
  assert.equal(again.status, 409);
  assert.equal(again.body.deployment.status, 'ready');
  close();
});

test('refusals use distinct status codes and a machine-readable code', async (t) => {
  await t.test('no payment method -> 402', async () => {
    const { call, close } = await boot();
    const r = await call('POST', '/feature/deploy', 'stranger');
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'payment_required');
    close();
  });
  await t.test('per-user cap -> 429', async () => {
    const { call, h, close } = await boot('convert', { limits: { maxActivePerUser: 1 } });
    h.store.seedReady('user-a', 'isolate', 'https://x', 'secret-value');
    const r = await call('POST', '/feature/deploy');
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'user_cap');
    close();
  });
  await t.test('kill switch -> 503', async () => {
    const { call, close } = await boot('convert', { limits: { disabled: true } });
    const r = await call('POST', '/feature/deploy');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'deployments_disabled');
    close();
  });
  await t.test('no sign-in -> 401 and nothing is created', async () => {
    const { call, h, close } = await boot();
    const r = await call('POST', '/feature/deploy', null);
    assert.equal(r.status, 401);
    assert.equal(h.store.rows.size, 0);
    close();
  });
});

test('GET /deploy: 404 when the user never deployed; a failed deploy is visible with its error, not a 404', async () => {
  const { h, call, close } = await boot();
  assert.equal((await call('GET', '/feature/deploy')).status, 404);

  h.cli.failOn.set('deploy', new Error('boom: image build failed'));
  assert.equal((await call('POST', '/feature/deploy')).status, 202);
  await h.manager.whenIdle();
  const get = await call('GET', '/feature/deploy');
  assert.equal(get.status, 200);
  assert.equal(get.body.status, 'failed');
  assert.match(get.body.error, /deployment failed/i);
  assert.doesNotMatch(get.text, /image build failed/, 'raw CLI output is not shown to users');
  close();
});

test('GET /deploy is per user: one user cannot see another user\'s deployment', async () => {
  const { h, call, close } = await boot();
  await call('POST', '/feature/deploy', 'user-a');
  await h.manager.whenIdle();
  assert.equal((await call('GET', '/feature/deploy', 'user-b')).status, 404);
  close();
});

test('DELETE /deploy tears down, a second DELETE is 404, and the user can deploy again', async () => {
  const { h, call, close } = await boot();
  await call('POST', '/feature/deploy');
  await h.manager.whenIdle();
  h.cli.calls.length = 0;

  const del = await call('DELETE', '/feature/deploy');
  assert.equal(del.status, 200);
  assert.equal(del.body.deleted, true);
  assert.equal(del.body.status, 'stopped');
  assert.deepEqual(h.cli.ops(), ['appStop', 'secretDelete']);

  assert.equal((await call('DELETE', '/feature/deploy')).status, 404);
  assert.equal((await call('GET', '/feature/deploy')).body.status, 'stopped', 'history stays visible');
  assert.equal((await call('POST', '/feature/deploy')).status, 202);
  await h.manager.whenIdle();
  close();
});

test('DELETE /deploy when Modal does not confirm the stop reports "stopping" and keeps retrying in the background', async () => {
  const { h, call, close } = await boot();
  await call('POST', '/feature/deploy');
  await h.manager.whenIdle();
  h.cli.failOn.set('appStop', new Error('modal app stop failed: network down'));
  const del = await call('DELETE', '/feature/deploy');
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'stopping');
  assert.equal((await call('GET', '/feature/deploy')).body.status, 'stopping');
  close();
});

test('GET /api/deployments lists the caller\'s deployments across services with the limits that apply', async () => {
  const { h, call, close } = await boot();
  h.store.seedReady('user-a', 'convert', 'https://c', 'secret-c-value');
  h.store.seedReady('user-a', 'isolate', 'https://i', 'secret-i-value');
  h.store.seedReady('user-b', 'convert', 'https://b', 'secret-b-value');

  const r = await call('GET', '/api/deployments');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.deployments.map((d: { service: string }) => d.service).sort(), ['convert', 'isolate']);
  assert.equal(r.body.limits.idle_timeout_minutes, 30);
  assert.equal(r.body.limits.max_age_minutes, 240);
  assert.equal(r.body.limits.payment_method_required, true);
  assert.equal(r.text.includes('secret-'), false);
  close();
});

test('GET /api/deployments without an identity -> 401', async () => {
  // Mounted without the auth stand-in, so req.userId is never set.
  const app = express();
  app.use('/api/deployments', createDeploymentsListRouter());
  const server = app.listen(0);
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/deployments`);
  assert.equal(res.status, 401);
  server.close();
});
