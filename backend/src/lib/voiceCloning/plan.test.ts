// npm test (node:test via tsx). Plan resolution for voice cloning when payments are switched off.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const load = async () => ({
  ...(await import('./runtime.js')),
  ...(await import('./service.js')),
  ...(await import('./policy.js')),
});

test('payment is required by default (flag unset or anything but "false")', async () => {
  const { paymentRequired } = await load();
  assert.equal(paymentRequired({}), true);
  assert.equal(paymentRequired({ VOICE_CLONE_REQUIRE_PAYMENT: 'true' }), true);
  assert.equal(paymentRequired({ VOICE_CLONE_REQUIRE_PAYMENT: '0' }), true); // only the literal "false" disables
  assert.equal(paymentRequired({ VOICE_CLONE_REQUIRE_PAYMENT: 'false' }), false);
});

test('resolvePlan: billing wins, free only when payment is switched off', async () => {
  const { resolvePlan } = await load();
  const off = { VOICE_CLONE_REQUIRE_PAYMENT: 'false' };
  assert.equal(resolvePlan({ active: true, comped: true }, off), 'comped');
  assert.equal(resolvePlan({ active: true, comped: false }, off), 'paid');
  assert.equal(resolvePlan(null, off), 'free');
  assert.equal(resolvePlan({ active: false, comped: false }, off), 'free');
  // default: no billing -> null (402 payment_required downstream)
  assert.equal(resolvePlan(null, {}), null);
  assert.equal(resolvePlan({ active: false, comped: true }, {}), null);
});

test('free plan passes eligibility but email must still be verified', async () => {
  const { assertEligible } = await load();
  assert.doesNotThrow(() => assertEligible({ userId: 'u', emailVerified: true, plan: 'free' }));
  assert.throws(() => assertEligible({ userId: 'u', emailVerified: false, plan: 'free' }), /Verify your email/);
  assert.throws(() => assertEligible({ userId: 'u', emailVerified: true, plan: null }), /paid plan/);
});

test('free plan gets the paid (conservative) daily limit, comped keeps the trial limit', async () => {
  const { dailyLimitFor, DEFAULT_POLICY } = await load();
  assert.equal(dailyLimitFor({ userId: 'u', emailVerified: true, plan: 'free' }, DEFAULT_POLICY), DEFAULT_POLICY.dailyLimitPaid);
  assert.equal(dailyLimitFor({ userId: 'u', emailVerified: true, plan: 'comped' }, DEFAULT_POLICY), DEFAULT_POLICY.dailyLimitTrial);
});
