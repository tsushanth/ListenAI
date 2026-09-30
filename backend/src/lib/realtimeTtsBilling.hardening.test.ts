// Run: npm test. Part A hardening: a billing row is only ever created/kept active when a payment method
// is really attached; Stripe subscription.updated keeps the row in sync; comped rows are never modified by Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.TTS_GATEWAY_ADMIN_SECRET = 'admin-secret';
process.env.TTS_GATEWAY_URL = 'http://gateway.test';
process.env.NODE_ENV = 'test';

const PRICE = 'price_1UCU4gKFBTQTkmztYE2RuWia';
const modP = import('./realtimeTtsBilling.js');

const session = (over: Record<string, unknown> = {}) =>
  ({ id: 'cs_1', customer: 'cus_u1', subscription: 'sub_1', metadata: { product: 'realtime-tts-api', userId: 'u1' }, ...over }) as any;
const sub = (over: Record<string, unknown> = {}) =>
  ({ id: 'sub_1', customer: 'cus_u1', status: 'active', metadata: {}, default_payment_method: null, items: { data: [{ id: 'si_1', price: { id: PRICE } }] }, ...over }) as any;

async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

test('checkout: subscription default_payment_method attached -> activates and enables the user\'s keys', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub({ default_payment_method: 'pm_1' });
  kit.tables.realtimetts_api_keys!.push({ user_id: 'u1', gateway_key_id: 'gk1', revoked_at: null });
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 1);
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
  assert.deepEqual(kit.gatewayCalls, [{ id: 'gk1', enabled: true }]);
}));

test('checkout: customer invoice_settings default payment method counts', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub();
  kit.stripeReturns['customers.retrieve'] = { id: 'cus_u1', invoice_settings: { default_payment_method: 'pm_2' } };
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 1);
}));

test('checkout: an attached card (paymentMethods.list) counts', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub();
  kit.stripeReturns['paymentMethods.list'] = { data: [{ id: 'pm_3' }] };
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 1);
}));

test('checkout: NO payment method anywhere -> refuses, nothing written, no key enabled', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub();
  kit.tables.realtimetts_api_keys!.push({ user_id: 'u1', gateway_key_id: 'gk1', revoked_at: null });
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
  assert.deepEqual(kit.gatewayCalls, []);
}));

test('checkout: Stripe failing while verifying the payment method fails closed', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub();
  kit.stripeReturns['customers.retrieve'] = () => { throw new Error('stripe down'); };
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
}));

test('checkout: purpose=internal-smoke-test on the subscription is refused even with a payment method', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub({ default_payment_method: 'pm_1', metadata: { purpose: 'internal-smoke-test' } });
  await activateBillingFromCheckout(session());
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
}));

test('checkout: purpose=internal-smoke-test on the session is refused too', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.stripeReturns['subscriptions.retrieve'] = sub({ default_payment_method: 'pm_1' });
  await activateBillingFromCheckout(session({ metadata: { product: 'realtime-tts-api', userId: 'u1', purpose: 'internal-smoke-test' } }));
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
}));

test('checkout: a comped row is never overwritten by a checkout upsert', () => withKit(async (kit) => {
  const { activateBillingFromCheckout } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ comped: true, stripe_customer_id: null, stripe_subscription_id: null, stripe_subscription_item_id: null }));
  kit.stripeReturns['subscriptions.retrieve'] = sub({ default_payment_method: 'pm_1' });
  await activateBillingFromCheckout(session());
  const row = kit.tables.realtimetts_billing![0]!;
  assert.equal(row.comped, true);
  assert.equal(row.stripe_customer_id, null);
  assert.equal(kit.writes.length, 0);
}));

// ---- subscription.updated sync -------------------------------------------------------------------

for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
  test(`subscription.updated status=${status} -> deactivates billing and disables keys`, () => withKit(async (kit) => {
    const { syncBillingFromSubscription } = await modP;
    kit.tables.realtimetts_billing!.push(billingRow());
    kit.tables.realtimetts_api_keys!.push({ user_id: 'u1', gateway_key_id: 'gk1', revoked_at: null });
    await syncBillingFromSubscription(sub({ status }));
    assert.equal(kit.tables.realtimetts_billing![0]!.active, false);
    assert.deepEqual(kit.gatewayCalls, [{ id: 'gk1', enabled: false }]);
  }));
}

test('subscription.updated status=past_due keeps billing active (grace period)', () => withKit(async (kit) => {
  const { syncBillingFromSubscription } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow());
  await syncBillingFromSubscription(sub({ status: 'past_due' }));
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
  assert.equal(kit.writes.length, 0);
}));

test('subscription.updated active again WITH a payment method -> re-activates and re-enables keys', () => withKit(async (kit) => {
  const { syncBillingFromSubscription } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ active: false }));
  kit.tables.realtimetts_api_keys!.push({ user_id: 'u1', gateway_key_id: 'gk1', revoked_at: null });
  await syncBillingFromSubscription(sub({ default_payment_method: 'pm_1' }));
  assert.equal(kit.tables.realtimetts_billing![0]!.active, true);
  assert.deepEqual(kit.gatewayCalls, [{ id: 'gk1', enabled: true }]);
}));

test('subscription.updated active again WITHOUT a payment method -> stays inactive', () => withKit(async (kit) => {
  const { syncBillingFromSubscription } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ active: false }));
  await syncBillingFromSubscription(sub());
  assert.equal(kit.tables.realtimetts_billing![0]!.active, false);
}));

test('subscription.updated active with no existing row does not create one', () => withKit(async (kit) => {
  const { syncBillingFromSubscription } = await modP;
  await syncBillingFromSubscription(sub({ default_payment_method: 'pm_1' }));
  assert.equal(kit.tables.realtimetts_billing!.length, 0);
}));

test('Stripe events never deactivate or modify a comped row (canceled / deleted / re-activate)', () => withKit(async (kit) => {
  const { syncBillingFromSubscription, deactivateBillingForSubscription } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ comped: true }));
  kit.tables.realtimetts_api_keys!.push({ user_id: 'u1', gateway_key_id: 'gk1', revoked_at: null });
  await syncBillingFromSubscription(sub({ status: 'canceled' }));
  await deactivateBillingForSubscription('sub_1');
  kit.tables.realtimetts_billing![0]!.active = false; // even if it were somehow inactive, Stripe must not flip it back
  await syncBillingFromSubscription(sub({ default_payment_method: 'pm_1' }));
  const row = kit.tables.realtimetts_billing![0]!;
  assert.equal(row.comped, true);
  assert.equal(row.active, false, 'untouched by re-activation');
  assert.equal(kit.writes.length, 0);
  assert.deepEqual(kit.gatewayCalls, []);
}));

test('comped account: canceled event leaves an active comped row active', () => withKit(async (kit) => {
  const { syncBillingFromSubscription, isBillingActiveForUser } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ comped: true }));
  await syncBillingFromSubscription(sub({ status: 'canceled' }));
  assert.equal(await isBillingActiveForUser('u1'), true);
}));
