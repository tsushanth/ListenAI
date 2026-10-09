// Run: npm test. A webhook handler error answers 500 and logs webhook_failed; a bad signature answers 400 and logs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { installKit, billingRow, type Kit } from '../../test/billingKit.js';

declare const require: (id: string) => any;

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.TTS_GATEWAY_ADMIN_SECRET = 'admin-secret';
process.env.TTS_GATEWAY_URL = 'http://gateway.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.NODE_ENV = 'test';

const Stripe = require('stripe');

async function post(kit: Kit, event: Record<string, unknown>): Promise<number> {
  const { stripeWebhookRouter: router } = await import('./stripeWebhook.js');
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use('/webhooks', router);
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const payload = JSON.stringify(event);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
    return r.status;
  } finally {
    server.close();
  }
}

test('a handler error answers 500 and logs webhook_failed', async () => {
  const kit = await installKit();
  const { supabase } = await import('../lib/supabaseClient.js');
  const sb = supabase as any;
  const wrapped = sb.from;
  sb.from = (t: string) => { if (t === 'users') throw new Error('boom'); return wrapped(t); };
  try {
    const status = await post(kit, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer_details: { email: 'a@example.test' }, customer: 'cus_1', subscription: 'sub_1' } } });
    await new Promise((r) => setImmediate(r));
    assert.equal(status, 500);
    const rows = (kit.tables.realtimetts_event_log ?? []).filter((r) => r.kind === 'webhook_failed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.detail, 'checkout.session.completed: boom');
  } finally { sb.from = wrapped; kit.restore(); }
});

test('a bad signature answers 400 and logs nothing', async () => {
  const kit = await installKit();
  try {
    const { stripeWebhookRouter: router } = await import('./stripeWebhook.js');
    const app = express(); app.use(express.raw({ type: 'application/json' })); app.use('/webhooks', router);
    const server = http.createServer(app).listen(0);
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
    server.close();
    assert.equal(r.status, 400);
    await new Promise((r2) => setImmediate(r2));
    assert.equal((kit.tables.realtimetts_event_log ?? []).length, 0);
  } finally { kit.restore(); }
});
