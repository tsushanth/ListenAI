import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretEvent, parsePlanMap, resolvePlan, type MapConfig } from './events.js';

const U = '11111111-2222-3333-4444-555555555555';
const cfg: MapConfig = { map: {}, acceptSandbox: false };
const base = { id: 'e1', event_timestamp_ms: 1000, app_user_id: U, product_id: 'ra_monthly:base', entitlement_ids: ['premium'], expiration_at_ms: 9_000_000, environment: 'PRODUCTION', store: 'PLAY_STORE' };
const rec = (d: ReturnType<typeof interpretEvent>) => { assert.equal(d.kind, 'apply'); return (d as any).records[0]; };

for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'BILLING_ISSUE']) {
  test(`${type} grants active basic until expiration_at_ms`, () => {
    const r = rec(interpretEvent({ ...base, type }, cfg));
    assert.equal(r.status, 'active'); assert.equal(r.planId, 'basic'); assert.equal(r.expiresAtMs, 9_000_000); assert.equal(r.userId, U);
  });
}
test('PRODUCT_CHANGE uses new_product_id for the plan map', () => {
  const r = rec(interpretEvent({ ...base, type: 'PRODUCT_CHANGE', new_product_id: 'ra_pro' }, { ...cfg, map: { ra_pro: 'pro' } }));
  assert.equal(r.planId, 'pro'); assert.equal(r.productId, 'ra_pro');
});
test('CANCELLATION keeps access until expiration', () => {
  const r = rec(interpretEvent({ ...base, type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' }, cfg));
  assert.equal(r.status, 'active'); assert.equal(r.expiresAtMs, 9_000_000); assert.equal(r.canceledAtMs, 1000);
});
test('CANCELLATION for a refund (CUSTOMER_SUPPORT) revokes now', () => {
  const r = rec(interpretEvent({ ...base, type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' }, cfg));
  assert.equal(r.status, 'expired'); assert.equal(r.expiresAtMs, 1000);
});
test('EXPIRATION expires', () => {
  const r = rec(interpretEvent({ ...base, type: 'EXPIRATION' }, cfg));
  assert.equal(r.status, 'expired');
});
test('EXPIRATION with no mapping info still expires', () => {
  const r = rec(interpretEvent({ id: 'e', type: 'EXPIRATION', event_timestamp_ms: 5, app_user_id: U }, cfg));
  assert.equal(r.status, 'expired'); assert.equal(r.expiresAtMs, 5);
});
test('anonymous and non-UUID ids are ignored', () => {
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', app_user_id: '$RCAnonymousID:abc' }, cfg).kind, 'ignore');
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', app_user_id: 'bob@example.com' }, cfg).kind, 'ignore');
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', app_user_id: undefined }, cfg).kind, 'ignore');
});
test('TEST, NON_RENEWING_PURCHASE, SUBSCRIPTION_PAUSED, unknown types are ignored', () => {
  for (const type of ['TEST', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_PAUSED', 'INVOICE_ISSUANCE', 'WHATEVER']) assert.equal(interpretEvent({ ...base, type }, cfg).kind, 'ignore', type);
});
test('sandbox ignored unless opted in', () => {
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', environment: 'SANDBOX' }, cfg).kind, 'ignore');
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', environment: 'SANDBOX' }, { ...cfg, acceptSandbox: true }).kind, 'apply');
});
test('missing id/type/timestamp and missing expiration are ignored', () => {
  assert.equal(interpretEvent({ type: 'RENEWAL', event_timestamp_ms: 1, app_user_id: U }, cfg).kind, 'ignore');
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', event_timestamp_ms: undefined }, cfg).kind, 'ignore');
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', expiration_at_ms: null }, cfg).kind, 'ignore');
});
test('no entitlement ids and unmapped product -> ignored; mapped product -> granted', () => {
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL', entitlement_ids: null }, cfg).kind, 'ignore');
  assert.equal(rec(interpretEvent({ ...base, type: 'RENEWAL', entitlement_ids: null }, { ...cfg, map: { 'ra_monthly': 'pro' } })).planId, 'pro');
});
test('map to free means no grant', () => {
  assert.equal(interpretEvent({ ...base, type: 'RENEWAL' }, { ...cfg, map: { ra_monthly: 'free' } }).kind, 'ignore');
});
test('TRANSFER revokes UUID source users only, with per-user ids', () => {
  const d = interpretEvent({ id: 't', type: 'TRANSFER', event_timestamp_ms: 7, transferred_from: [U, '$RCAnonymousID:x'], transferred_to: ['z'] }, cfg);
  assert.equal(d.kind, 'apply'); const rs = (d as any).records; assert.equal(rs.length, 1); assert.equal(rs[0].eventId, `t:${U}`); assert.equal(rs[0].status, 'expired');
  assert.equal(interpretEvent({ id: 't', type: 'TRANSFER', event_timestamp_ms: 7, transferred_from: ['$RCAnonymousID:x'] }, cfg).kind, 'ignore');
});
test('parsePlanMap / resolvePlan', () => {
  assert.deepEqual(parsePlanMap(undefined), {}); assert.deepEqual(parsePlanMap('not json'), {}); assert.deepEqual(parsePlanMap('[1]'), {});
  assert.deepEqual(parsePlanMap('{"a":"pro","b":"gold","c":5}'), { a: 'pro' });
  assert.equal(resolvePlan('p:plan', [], { p: 'unlimited' }), 'unlimited');
  assert.equal(resolvePlan(null, ['ent'], { ent: 'pro' }), 'pro');
});
