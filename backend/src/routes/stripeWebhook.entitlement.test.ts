// Run: npm test. The signed webhook path for ReadAloud web Pro: signature, flag, replay, and isolation from realtime-tts.
// Stripe is never called (events are built and signed locally with a test secret); Supabase is an in-memory fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { installKit, billingRow } from '../../test/billingKit.js';
import { memStore } from '../../test/entitlementKit.js';

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
const U1 = '11111111-1111-4111-8111-111111111111';
const T0 = 1_793_000_000;

async function send(payload: string, header: string | null): Promise<number> {
  const { stripeWebhookRouter: router } = await import('./stripeWebhook.js');
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use('/webhooks', router);
  const server = http.createServer(app).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (header) headers['stripe-signature'] = header;
    return (await fetch(`http://127.0.0.1:${port}/webhooks/stripe`, { method: 'POST', headers, body: payload })).status;
  } finally {
    server.close();
  }
}
const signed = (event: unknown) => {
  const payload = JSON.stringify(event);
  return send(payload, Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' }));
};

const checkoutEvent = (id = 'evt_co1') => ({
  id, object: 'event', type: 'checkout.session.completed', created: T0,
  data: { object: { id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid', client_reference_id: U1,
    customer: 'cus_1', subscription: 'sub_1', customer_email: 'a@example.com', metadata: { source: 'readaloud_web_pricing', user_id: U1 } } },
});
const cancelEvent = () => ({
  id: 'evt_del1', object: 'event', type: 'customer.subscription.deleted', created: T0 + 100,
  data: { object: { id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'canceled', metadata: { source: 'readaloud_web_pricing', user_id: U1 } } },
});

async function withEnv(flag: string | undefined, fn: (m: ReturnType<typeof memStore>) => Promise<void>) {
  const prev = process.env.WEB_PRO_ENTITLEMENT_ENABLED;
  if (flag === undefined) delete process.env.WEB_PRO_ENTITLEMENT_ENABLED; else process.env.WEB_PRO_ENTITLEMENT_ENABLED = flag;
  const { __setEntitlementStoreForTests } = await import('./stripeWebhook.js');
  const m = memStore();
  __setEntitlementStoreForTests(m.store);
  const kit = await installKit();
  try { await fn(m); } finally {
    kit.restore();
    __setEntitlementStoreForTests(null);
    if (prev === undefined) delete process.env.WEB_PRO_ENTITLEMENT_ENABLED; else process.env.WEB_PRO_ENTITLEMENT_ENABLED = prev;
  }
}

test('flag on: a signed checkout.session.completed grants pro; a replay of the same event id is a 200 no-op', () => withEnv('true', async (m) => {
  assert.equal(await signed(checkoutEvent()), 200);
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  const writes = m.calls.writeEffective;
  assert.equal(await signed(checkoutEvent()), 200);
  assert.equal(m.calls.writeEffective, writes);
}));

test('flag on: subscription.deleted revokes through the same endpoint', () => withEnv('true', async (m) => {
  await signed(checkoutEvent());
  assert.equal(await signed(cancelEvent()), 200);
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
}));

test('flag on: a bad signature is rejected with 400 and nothing is written', () => withEnv('true', async (m) => {
  const payload = JSON.stringify(checkoutEvent());
  const bad = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_WRONG' });
  assert.equal(await send(payload, bad), 400);
  assert.equal(await send(payload, null), 400);
  assert.equal(m.subs.size + m.sources.length + m.events.size, 0);
}));

test('flag on: a payload tampered after signing is rejected', () => withEnv('true', async (m) => {
  const payload = JSON.stringify(checkoutEvent());
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  assert.equal(await send(payload.replace('sub_1', 'sub_9'), header), 400);
  assert.equal(m.subs.size, 0);
}));

test('flag on: a handler failure answers 500 so Stripe retries, and the retry then succeeds', () => withEnv('true', async (m) => {
  m.failNextUpsert();
  assert.equal(await signed(checkoutEvent()), 500);
  assert.equal(m.subs.size, 0);
  assert.equal(await signed(checkoutEvent()), 200);
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
}));

test('flag on: an unmatched paid checkout still answers 200 (no retry storm) but writes nothing', () => withEnv('true', async (m) => {
  const e = checkoutEvent() as any;
  e.data.object.client_reference_id = null;
  assert.equal(await signed(e), 200);
  assert.equal(m.subs.size, 0);
}));

test('flag off (default): the entitlement store is never touched', () => withEnv(undefined, async (m) => {
  assert.equal(await signed(checkoutEvent()), 200);
  assert.equal(await signed(cancelEvent()), 200);
  assert.equal(m.calls.claim + m.calls.upsertSource + m.calls.writeEffective, 0);
}));

test('flag "false" behaves like unset', () => withEnv('false', async (m) => {
  assert.equal(await signed(checkoutEvent()), 200);
  assert.equal(m.calls.claim, 0);
}));

test('flag on: realtime-tts events keep their own path and never reach the web Pro handler', () => withEnv('true', async (m) => {
  const created: any = { id: 'evt_rt', object: 'event', type: 'customer.subscription.deleted', created: T0,
    data: { object: { id: 'sub_rt', object: 'subscription', customer: 'cus_rt', status: 'canceled', metadata: { product: 'realtime-tts-api', userId: 'u1' } } } };
  const kit2 = await installKit();
  try {
    kit2.tables.realtimetts_billing!.push(billingRow({ stripe_subscription_id: 'sub_rt' }));
    assert.equal(await signed(created), 200);
    assert.equal(kit2.tables.realtimetts_billing![0]!.active, false, 'realtime-tts billing still deactivated');
  } finally { kit2.restore(); }
  assert.equal(m.calls.claim, 0);
}));
