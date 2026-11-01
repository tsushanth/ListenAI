// Run: npm test. Checkout reuses the user's existing Stripe customer instead of creating a duplicate, and
// repeat calls inside a short window are idempotent. Price, line items and metadata are unchanged.
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');
let kit: Kit;
beforeEach(async () => { kit = await installKit(); });
afterEach(() => kit.restore());

const args = { userId: 'u1', email: 'a@example.test', successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' };
const createCalls = () => kit.stripeCalls.filter((c) => c.name === 'checkout.sessions.create');

test('a user with no billing row gets customer_email (a new customer is created at completion, as before)', async () => {
  const { createCheckoutSession } = await modP;
  const url = await createCheckoutSession(args);
  assert.equal(url, 'https://checkout.stripe.test/cs_1');
  const p = createCalls()[0].args[0] as any;
  assert.equal(p.customer_email, 'a@example.test');
  assert.equal(p.customer, undefined);
  assert.equal(p.mode, 'subscription');
  assert.equal(p.metadata.userId, 'u1');
  assert.equal(p.subscription_data.metadata.userId, 'u1');
  assert.equal(p.line_items[0].price, 'price_1UCU4gKFBTQTkmztYE2RuWia');
});

test('a returning subscriber (stored customer still exists) is sent to checkout as that customer', async () => {
  const { createCheckoutSession } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ active: false, stripe_customer_id: 'cus_u1' }));
  kit.stripeReturns['customers.retrieve'] = { id: 'cus_u1', invoice_settings: {} };
  await createCheckoutSession(args);
  const p = createCalls()[0].args[0] as any;
  assert.equal(p.customer, 'cus_u1');
  assert.equal(p.customer_email, undefined); // Stripe rejects both together
});

test('a deleted or unreachable stored customer falls back to customer_email instead of failing checkout', async () => {
  const { createCheckoutSession } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ active: false, stripe_customer_id: 'cus_gone' }));
  kit.stripeReturns['customers.retrieve'] = { id: 'cus_gone', deleted: true };
  await createCheckoutSession(args);
  assert.equal((createCalls()[0].args[0] as any).customer, undefined);
  assert.equal((createCalls()[0].args[0] as any).customer_email, 'a@example.test');

  kit.stripeCalls.length = 0;
  kit.stripeThrows['customers.retrieve'] = new Error('No such customer');
  await createCheckoutSession(args);
  assert.equal((createCalls()[0].args[0] as any).customer_email, 'a@example.test');
});

test('the idempotency key is stable for identical params and differs per user, email and customer', async () => {
  const { createCheckoutSession } = await modP;
  const key = () => (createCalls().at(-1)!.args[1] as any).idempotencyKey as string;
  await createCheckoutSession(args);
  const k1 = key();
  await createCheckoutSession(args);
  assert.equal(key(), k1);
  await createCheckoutSession({ ...args, email: 'b@example.test' });
  assert.notEqual(key(), k1);
  await createCheckoutSession({ ...args, userId: 'u2' });
  assert.notEqual(key(), k1);
});

test('throws when Stripe returns no url', async () => {
  const { createCheckoutSession } = await modP;
  kit.stripeReturns['checkout.sessions.create'] = { id: 'cs_x', url: null };
  await assert.rejects(() => createCheckoutSession(args), /checkout URL/);
});
