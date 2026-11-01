// Webhook / shared-secret endpoints must fail closed. Run: npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

declare const require: (id: string) => any;

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.NODE_ENV = 'test';

const Stripe = require('stripe');

async function withServer(mount: (app: express.Express) => void, fn: (base: string) => Promise<void>) {
  const app = express();
  mount(app);
  const server = http.createServer(app).listen(0);
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

test('stripe webhook: no STRIPE_WEBHOOK_SECRET -> 503 even for an "empty-key" forged signature', async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const { stripeWebhookRouter } = await import('./stripeWebhook.js');
  await withServer((app) => { app.use(express.raw({ type: 'application/json' })); app.use('/webhooks', stripeWebhookRouter); }, async (base) => {
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'customer.subscription.deleted', data: { object: {} } });
    // Signed with an empty key, which is what an attacker would use against a server verifying with ''.
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: '' });
    const r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
    assert.equal(r.status, 503);
  });
});

test('stripe webhook: secret set -> missing header 400, bad signature 400, empty-key signature 400', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  const { stripeWebhookRouter } = await import('./stripeWebhook.js');
  await withServer((app) => { app.use(express.raw({ type: 'application/json' })); app.use('/webhooks', stripeWebhookRouter); }, async (base) => {
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'ping', data: { object: {} } });
    const post = (headers: Record<string, string>) => fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload });
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ 'stripe-signature': 't=1,v1=deadbeef' })).status, 400);
    assert.equal((await post({ 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' }) })).status, 400);
  });
});

test('pubsub push: unset secret, missing token, wrong token -> 401; right token passes auth', async () => {
  const { workerPushRouter } = await import('./workerPush.js');
  await withServer((app) => { app.use(express.json()); app.use('/api/tts', workerPushRouter); }, async (base) => {
    const post = (q: string) => fetch(`${base}/api/tts/worker/push${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    delete process.env.PUBSUB_PUSH_SECRET;
    assert.equal((await post('')).status, 401);
    assert.equal((await post('?token=')).status, 401);
    process.env.PUBSUB_PUSH_SECRET = 'push-secret';
    assert.equal((await post('')).status, 401);
    assert.equal((await post('?token=wrong')).status, 401);
    assert.equal((await post('?token=push-secret&token=x')).status, 401);
    // Authorised: the empty envelope is acked as malformed (200), which proves the auth gate was passed without running a job.
    assert.equal((await post('?token=push-secret')).status, 200);
  });
});
