// Run: npm test (node:test via tsx). Web Pro entitlement logic against an in-memory store with hand-built Stripe events.
// No Stripe API, no Supabase, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import type Stripe from 'stripe';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import {
  handleStripeEvent, resolveEffective, recomputeEffective, sourceIsActive, webProEntitlementEnabled,
  PERIOD_END_GRACE_MS, WEB_CHECKOUT_SOURCE,
  type SourceRow,
} from './webEntitlement.js';
import { memStore } from '../../test/entitlementKit.js';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-03T12:00:00Z');
const T0 = Math.floor(NOW / 1000);
const DAY = 86400;

const ev = (id: string, type: string, object: unknown, created = T0): Stripe.Event =>
  ({ id, object: 'event', type, created, data: { object } }) as unknown as Stripe.Event;

const checkout = (over: Record<string, unknown> = {}, id = 'evt_co') => ev(id, 'checkout.session.completed', {
  id: 'cs_test_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
  client_reference_id: U1, customer: 'cus_1', subscription: 'sub_1', customer_email: 'a@example.com',
  metadata: { source: WEB_CHECKOUT_SOURCE, plan: 'pro_weekly', user_id: U1 }, ...over,
});

const subscription = (type: string, status: string, over: Record<string, unknown> = {}, id = `evt_${type}_${status}`, created = T0) =>
  ev(id, type, {
    id: 'sub_1', object: 'subscription', customer: 'cus_1', status,
    current_period_end: T0 + 7 * DAY, trial_end: null, canceled_at: null,
    metadata: { source: WEB_CHECKOUT_SOURCE, user_id: U1 }, ...over,
  }, created);

const sourceRow = (over: Partial<SourceRow> = {}): SourceRow => ({
  user_id: U1, source: 'stripe', tier: 'pro', status: 'active', stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1',
  current_period_end: new Date(NOW + 7 * DAY * 1000).toISOString(), canceled_at: null, last_event_created: T0, ...over,
});

// ---- flag --------------------------------------------------------------------------------------------------------

test('the entitlement path is off unless WEB_PRO_ENTITLEMENT_ENABLED is exactly "true"', () => {
  assert.equal(webProEntitlementEnabled({}), false);
  for (const v of ['1', 'TRUE', 'yes', 'false', '']) assert.equal(webProEntitlementEnabled({ WEB_PRO_ENTITLEMENT_ENABLED: v }), false, v);
  assert.equal(webProEntitlementEnabled({ WEB_PRO_ENTITLEMENT_ENABLED: 'true' }), true);
});

// ---- pure resolution ---------------------------------------------------------------------------------------------

test('highest tier wins across sources; free sources never lower it', () => {
  const eff = resolveEffective([
    sourceRow({ source: 'revenuecat', tier: 'pro', stripe_subscription_id: null }),
    sourceRow({ source: 'stripe', tier: 'free', status: 'canceled' }),
  ], NOW);
  assert.equal(eff.tier, 'pro');
  const both = resolveEffective([sourceRow({ tier: 'pro' }), sourceRow({ source: 'revenuecat', tier: 'unlimited' })], NOW);
  assert.equal(both.tier, 'unlimited');
});

test('no active source resolves to free; past_due still counts, canceled/expired do not', () => {
  assert.equal(resolveEffective([], NOW).tier, 'free');
  assert.equal(resolveEffective([sourceRow({ status: 'past_due' })], NOW).tier, 'pro');
  assert.equal(resolveEffective([sourceRow({ status: 'trialing' })], NOW).tier, 'pro');
  assert.equal(resolveEffective([sourceRow({ status: 'canceled' })], NOW).tier, 'free');
  assert.equal(resolveEffective([sourceRow({ status: 'expired' })], NOW).status, 'expired');
});

test('a stale period end lapses only after the grace window', () => {
  const justInside = new Date(NOW - PERIOD_END_GRACE_MS + 60_000).toISOString();
  const outside = new Date(NOW - PERIOD_END_GRACE_MS - 60_000).toISOString();
  assert.equal(sourceIsActive(sourceRow({ current_period_end: justInside }), NOW), true);
  assert.equal(sourceIsActive(sourceRow({ current_period_end: outside }), NOW), false);
  assert.equal(sourceIsActive(sourceRow({ current_period_end: null }), NOW), true);
});

// ---- checkout.session.completed ----------------------------------------------------------------------------------

test('checkout.session.completed resolves by client_reference_id and grants pro in the table getUserTier reads', async () => {
  const m = memStore();
  const r = await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  assert.deepEqual(r, { outcome: 'applied', userId: U1, recompute: 'written' });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.get(U1)?.entitlement_managed, true);
  assert.equal(m.subs.get(U1)?.stripe_subscription_id, 'sub_1');
  assert.equal(m.sources[0]?.source, 'stripe');
  assert.ok(m.appUsers.has(U1), 'FK target app_users row ensured');
});

test('falls back to the account email when client_reference_id is absent', async () => {
  const m = memStore();
  m.appUsers.set(U2, 'Buyer@Example.com');
  const r = await handleStripeEvent(checkout({ client_reference_id: null, customer_email: 'buyer@example.com' }), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'applied');
  assert.equal(m.subs.get(U2)?.plan_id, 'pro');
});

test('client_reference_id wins over a different email', async () => {
  const m = memStore();
  m.appUsers.set(U2, 'other@example.com');
  await handleStripeEvent(checkout({ customer_email: 'other@example.com' }), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.has(U2), false);
});

test('a malformed client_reference_id is ignored (falls through to email)', async () => {
  const m = memStore();
  m.appUsers.set(U2, 'a@example.com');
  const r = await handleStripeEvent(checkout({ client_reference_id: "1; drop table users" }), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'applied');
  assert.equal(m.subs.get(U2)?.plan_id, 'pro');
});

test('no id and no unique email match: unresolved, nothing written, claim released so it can be re-sent', async () => {
  const m = memStore();
  const r = await handleStripeEvent(checkout({ client_reference_id: null }), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'unresolved');
  assert.equal(m.subs.size, 0);
  assert.equal(m.sources.length, 0);
  assert.equal(m.events.has('evt_co'), false);
  // two accounts with the same email is ambiguous: never guess
  m.appUsers.set(U1, 'a@example.com');
  m.appUsers.set(U2, 'a@example.com');
  assert.equal((await handleStripeEvent(checkout({ client_reference_id: null }), { store: m.store, nowMs: NOW })).outcome, 'unresolved');
});

test('checkouts that are not ReadAloud web subscriptions are ignored (shared Stripe account)', async () => {
  const m = memStore();
  const realtime = checkout({ metadata: { product: 'realtime-tts-api' } }, 'evt_a');
  assert.equal((await handleStripeEvent(realtime, { store: m.store, nowMs: NOW })).outcome, 'ignored');
  assert.equal((await handleStripeEvent(checkout({ mode: 'payment' }, 'evt_b'), { store: m.store, nowMs: NOW })).outcome, 'ignored');
  assert.equal((await handleStripeEvent(checkout({ payment_status: 'unpaid' }, 'evt_c'), { store: m.store, nowMs: NOW })).outcome, 'ignored');
  assert.equal((await handleStripeEvent(checkout({ subscription: null }, 'evt_d'), { store: m.store, nowMs: NOW })).outcome, 'ignored');
  assert.equal(m.subs.size + m.sources.length, 0);
});

test('a replayed event id is a no-op: no second write', async () => {
  const m = memStore();
  assert.equal((await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW })).outcome, 'applied');
  const before = { ...m.calls };
  assert.deepEqual(await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW }), { outcome: 'duplicate' });
  assert.equal(m.calls.writeEffective, before.writeEffective);
  assert.equal(m.calls.upsertSource, before.upsertSource);
});

test('a handler failure releases the claim so Stripe\'s retry of the same event is processed', async () => {
  const m = memStore();
  m.failNextUpsert();
  await assert.rejects(handleStripeEvent(checkout(), { store: m.store, nowMs: NOW }), /db down/);
  assert.equal(m.events.has('evt_co'), false);
  assert.equal((await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW })).outcome, 'applied');
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
});

// ---- customer.subscription.* -------------------------------------------------------------------------------------

test('subscription.updated trialing and active keep pro and store the period end', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  await handleStripeEvent(subscription('customer.subscription.updated', 'trialing', { trial_end: T0 + 3 * DAY }, 'evt_a'), { store: m.store, nowMs: NOW });
  assert.equal(m.sources[0]?.status, 'trialing');
  assert.equal(m.sources[0]?.current_period_end, new Date((T0 + 3 * DAY) * 1000).toISOString());
  await handleStripeEvent(subscription('customer.subscription.updated', 'active', {}, 'evt_b', T0 + 10), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.get(U1)?.status, 'active');
});

test('subscription.updated past_due keeps pro (grace); canceled and unpaid take it away', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  await handleStripeEvent(subscription('customer.subscription.updated', 'past_due', {}, 'evt_pd', T0 + 10), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.get(U1)?.status, 'past_due');
  await handleStripeEvent(subscription('customer.subscription.updated', 'unpaid', {}, 'evt_up', T0 + 20), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
  assert.equal(m.subs.get(U1)?.status, 'expired');
  await handleStripeEvent(subscription('customer.subscription.updated', 'active', {}, 'evt_re', T0 + 30), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  await handleStripeEvent(subscription('customer.subscription.updated', 'canceled', { canceled_at: T0 + 40 }, 'evt_ca', T0 + 40), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
  assert.equal(m.subs.get(U1)?.status, 'canceled');
});

test('subscription.deleted revokes pro', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  const r = await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', { canceled_at: T0 + 5 }, 'evt_del', T0 + 5), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'applied');
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
  assert.equal(m.sources[0]?.tier, 'free');
  assert.ok(m.sources[0]?.canceled_at);
});

test('an incomplete subscription grants and revokes nothing', async () => {
  const m = memStore();
  const r = await handleStripeEvent(subscription('customer.subscription.created', 'incomplete'), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'ignored');
  assert.equal(m.subs.size, 0);
});

test('a subscription that is not ours (no ledger row, no web metadata) is ignored', async () => {
  const m = memStore();
  const r = await handleStripeEvent(subscription('customer.subscription.updated', 'active', { metadata: { product: 'realtime-tts-api', userId: 'u1' } }), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'ignored');
  assert.equal(m.subs.size, 0);
});

test('subscription.updated arriving before checkout.session.completed still resolves by metadata, and a later checkout cannot undo a cancel', async () => {
  const m = memStore();
  await handleStripeEvent(subscription('customer.subscription.updated', 'active', {}, 'evt_s1', T0 + 5), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_s2', T0 + 100), { store: m.store, nowMs: NOW });
  const late = await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW }); // event.created = T0, older than the delete
  assert.equal(late.outcome, 'stale');
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
});

test('out-of-order: an older updated event delivered after a newer one is ignored', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  await handleStripeEvent(subscription('customer.subscription.updated', 'canceled', {}, 'evt_new', T0 + 100), { store: m.store, nowMs: NOW });
  const r = await handleStripeEvent(subscription('customer.subscription.updated', 'active', {}, 'evt_old', T0 + 50), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'stale');
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
});

// ---- invoice.payment_failed --------------------------------------------------------------------------------------

test('invoice.payment_failed marks past_due but keeps pro until Stripe ends the subscription', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  const inv = ev('evt_inv', 'invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1', attempt_count: 1 }, T0 + 60);
  const r = await handleStripeEvent(inv, { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'applied');
  assert.equal(m.sources[0]?.status, 'past_due');
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.get(U1)?.status, 'past_due');
});

test('invoice.payment_failed for an unknown subscription, or one already ended, changes nothing', async () => {
  const m = memStore();
  const other = ev('evt_i2', 'invoice.payment_failed', { id: 'in_2', object: 'invoice', customer: 'cus_x', subscription: 'sub_other' });
  assert.equal((await handleStripeEvent(other, { store: m.store, nowMs: NOW })).outcome, 'ignored');
  m.sources.push(sourceRow({ tier: 'free', status: 'canceled' }));
  const ended = ev('evt_i3', 'invoice.payment_failed', { id: 'in_3', object: 'invoice', customer: 'cus_1', subscription: 'sub_1' }, T0 + 1);
  assert.equal((await handleStripeEvent(ended, { store: m.store, nowMs: NOW })).outcome, 'ignored');
  assert.equal(m.subs.size, 0);
});

test('event types outside the handled set are ignored without touching the store', async () => {
  const m = memStore();
  const r = await handleStripeEvent(ev('evt_x', 'invoice.payment_succeeded', { id: 'in_9' }), { store: m.store, nowMs: NOW });
  assert.equal(r.outcome, 'ignored');
  assert.equal(m.calls.claim, 0);
});

// ---- how channels combine ----------------------------------------------------------------------------------------

test('a Stripe cancellation does not remove Pro that another source (Android/RevenueCat) still grants', async () => {
  const m = memStore();
  m.sources.push(sourceRow({ source: 'revenuecat', stripe_customer_id: null, stripe_subscription_id: null }));
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_d', T0 + 9), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
});

test('a hand-set subscriptions row (comp / unlimited) is never lowered by a Stripe event', async () => {
  const m = memStore();
  m.subs.set(U1, { plan_id: 'unlimited', entitlement_managed: false });
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'unlimited');
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_d', T0 + 9), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'unlimited');
  assert.equal(m.subs.get(U1)?.entitlement_managed, false);
});

test('a hand-set free row is raised to pro by a purchase and from then on follows the ledger', async () => {
  const m = memStore();
  m.subs.set(U1, { plan_id: 'free', entitlement_managed: false });
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.subs.get(U1)?.entitlement_managed, true);
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_d', T0 + 9), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
});

test('recomputeEffective is idempotent', async () => {
  const m = memStore();
  m.sources.push(sourceRow());
  assert.equal(await recomputeEffective(U1, m.store, NOW), 'written');
  assert.equal(await recomputeEffective(U1, m.store, NOW), 'written');
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
});

test('cancelling an older web subscription does not revoke the newer one that replaced it', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW }); // sub_1
  await handleStripeEvent(checkout({ subscription: 'sub_2' }, 'evt_co2'), { store: m.store, nowMs: NOW }); // user bought again: sub_2 is current
  assert.equal(m.sources[0]?.stripe_subscription_id, 'sub_2');
  const r = await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_old_del', T0 + 50), { store: m.store, nowMs: NOW }); // sub_1 ends
  assert.equal(r.outcome, 'ignored');
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  // and the current one ending does revoke
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', { id: 'sub_2' }, 'evt_cur_del', T0 + 60), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
});

test('resubscribing after a cancellation grants pro again, and the old subscription staying cancelled does not undo it', async () => {
  const m = memStore();
  await handleStripeEvent(checkout(), { store: m.store, nowMs: NOW });
  await handleStripeEvent(subscription('customer.subscription.deleted', 'canceled', {}, 'evt_del', T0 + 5), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'free');
  await handleStripeEvent(checkout({ subscription: 'sub_3' }, 'evt_co3'), { store: m.store, nowMs: NOW });
  // checkout event.created (T0) is older than the delete (T0+5), so a provisional grant would be ignored: the new
  // subscription's own events carry the truth
  await handleStripeEvent(subscription('customer.subscription.created', 'active', { id: 'sub_3' }, 'evt_new', T0 + 100), { store: m.store, nowMs: NOW });
  assert.equal(m.subs.get(U1)?.plan_id, 'pro');
  assert.equal(m.sources[0]?.stripe_subscription_id, 'sub_3');
});
