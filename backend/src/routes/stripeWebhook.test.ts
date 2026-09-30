// Run: npm test. Exercises the real signed-webhook path for realtime-tts subscriptions: customer.subscription.updated
// must deactivate/re-activate the billing row, leave past_due alone, and never touch a comped row.
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
const PRICE = 'price_1UCU4gKFBTQTkmztYE2RuWia';

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

const updated = (over: Record<string, unknown>) => ({
  id: 'evt_1', object: 'event', type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_u1', status: 'canceled', metadata: { product: 'realtime-tts-api', userId: 'u1' }, default_payment_method: null, items: { data: [{ id: 'si_1', price: { id: PRICE } }] }, ...over } },
});

async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

test('webhook: subscription.updated canceled for a realtime-tts sub deactivates billing', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow());
  assert.equal(await post(kit, updated({ status: 'canceled' })), 200);
  assert.equal(kit.tables.realtimetts_billing![0]!.active, false);
}));

test('webhook: subscription.updated past_due leaves billing active', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow());
  assert.equal(await post(kit, updated({ status: 'past_due' })), 200);
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
}));

test('webhook: subscription.updated active + payment method re-activates', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ active: false }));
  assert.equal(await post(kit, updated({ status: 'active', default_payment_method: 'pm_1' })), 200);
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
}));

test('webhook: a comped row is untouched by a canceled event', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow({ comped: true }));
  assert.equal(await post(kit, updated({ status: 'canceled' })), 200);
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
  assert.equal(kit.writes.length, 0);
}));

test('webhook: customer.subscription.deleted still deactivates (unchanged), but not a comped row', () => withKit(async (kit) => {
  kit.tables.realtimetts_billing!.push(billingRow(), billingRow({ user_id: 'u2', stripe_subscription_id: 'sub_2', comped: true }));
  await post(kit, { ...updated({}), type: 'customer.subscription.deleted' });
  await post(kit, { ...updated({ id: 'sub_2' }), type: 'customer.subscription.deleted' });
  assert.equal(kit.tables.realtimetts_billing![0]!.active, false);
  assert.equal(kit.tables.realtimetts_billing![1]!.active, true);
}));

test('webhook: checkout.session.completed with no payment method does not activate billing', () => withKit(async (kit) => {
  kit.stripeReturns['subscriptions.retrieve'] = { id: 'sub_1', customer: 'cus_u1', status: 'active', metadata: {}, default_payment_method: null, items: { data: [{ id: 'si_1', price: { id: PRICE } }] } };
  const ev = { id: 'evt_2', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1', customer: 'cus_u1', subscription: 'sub_1', metadata: { product: 'realtime-tts-api', userId: 'u1' } } } };
  assert.equal(await post(kit, ev), 200);
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
}));
