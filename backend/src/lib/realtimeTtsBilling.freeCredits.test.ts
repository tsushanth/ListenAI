// Run: npm test. Part B free credits + comped accounts: allowance gate, per-reporter metering
// (Stripe for paying users, free-credit deduction for free users, nothing at all for comped users).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, stripeMeterCalls, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');
const COMPED = billingRow({ comped: true, stripe_customer_id: null, stripe_subscription_id: null, stripe_subscription_item_id: null });

async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

test('FREE_CREDIT_UNITS is 10,000 units ($0.10 at $0.00001/unit)', async () => {
  const { FREE_CREDIT_UNITS, METER_USD_PER_UNIT } = await modP;
  assert.equal(FREE_CREDIT_UNITS, 10000);
  assert.equal(Math.round(FREE_CREDIT_UNITS * METER_USD_PER_UNIT * 100), 10);
});

// ---- balance + gate -------------------------------------------------------------------------------

test('getFreeCredits: no row yet = full untouched grant', () => withKit(async () => {
  const { getFreeCredits, FREE_CREDIT_UNITS } = await modP;
  assert.deepEqual(await getFreeCredits('u1'), { granted: FREE_CREDIT_UNITS, used: 0, remaining: FREE_CREDIT_UNITS });
}));

test('getFreeCredits: reads granted/used, remaining never negative', () => withKit(async (kit) => {
  const { getFreeCredits } = await modP;
  kit.tables.realtimetts_free_credits!.push({ user_id: 'u1', granted: 10000, used: 12000 });
  assert.deepEqual(await getFreeCredits('u1'), { granted: 10000, used: 12000, remaining: 0 });
}));

test('hasUsageAllowance: free user with credits -> true; exhausted -> false', () => withKit(async (kit) => {
  const { hasUsageAllowance } = await modP;
  assert.equal(await hasUsageAllowance('u1'), true);
  kit.tables.realtimetts_free_credits!.push({ user_id: 'u1', granted: 10000, used: 10000 });
  assert.equal(await hasUsageAllowance('u1'), false);
}));

test('hasUsageAllowance: paying and comped users are always allowed, even with exhausted credits', () => withKit(async (kit) => {
  const { hasUsageAllowance } = await modP;
  kit.tables.realtimetts_free_credits!.push({ user_id: 'u1', granted: 10000, used: 10000 }, { user_id: 'u2', granted: 10000, used: 10000 });
  kit.tables.realtimetts_billing!.push(billingRow(), billingRow({ user_id: 'u2', comped: true }));
  assert.equal(await hasUsageAllowance('u1'), true);
  assert.equal(await hasUsageAllowance('u2'), true);
}));

test('hasUsageAllowance: an inactive (cancelled) row does not count as billing', () => withKit(async (kit) => {
  const { hasUsageAllowance } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ active: false }));
  kit.tables.realtimetts_free_credits!.push({ user_id: 'u1', granted: 10000, used: 10000 });
  assert.equal(await hasUsageAllowance('u1'), false);
}));

test('isBillingActiveForUser: true for comped rows, false for none', () => withKit(async (kit) => {
  const { isBillingActiveForUser } = await modP;
  assert.equal(await isBillingActiveForUser('u1'), false);
  kit.tables.realtimetts_billing!.push(COMPED);
  assert.equal(await isBillingActiveForUser('u1'), true);
}));

test('consumeFreeCredits: passes the single FREE_CREDIT_UNITS grant and the identifier to the SQL function; rpc error -> 0', () => withKit(async (kit) => {
  const { consumeFreeCredits, FREE_CREDIT_UNITS } = await modP;
  assert.equal(await consumeFreeCredits('u1', 300, 'dub-1'), 300);
  assert.deepEqual(kit.rpcCalls[0], { fn: 'consume_free_credits', args: { p_user: 'u1', p_units: 300, p_grant: FREE_CREDIT_UNITS, p_identifier: 'dub-1' } });
  kit.rpcError = true;
  assert.equal(await consumeFreeCredits('u1', 300), 0);
  assert.equal(await consumeFreeCredits('u1', 0), 0);
}));

test('freeCreditsExhaustedMessage points at the add-payment-method URL and differs from the payment-only message', async () => {
  const { freeCreditsExhaustedMessage } = await modP;
  const m = freeCreditsExhaustedMessage('dubbing');
  assert.match(m, /free credits are used up/i);
  assert.match(m, /https:\/\/readaloudai\.org\/developers#get-started/);
});

// ---- metering: free user deducts, paying user -> Stripe, comped -> nothing ----------------------------

test('free user: reportTtsUsage / reportSttUsage / reportVoiceDesignUsage deduct credits and never call Stripe', () => withKit(async (kit) => {
  const { reportTtsUsage, reportSttUsage, reportVoiceDesignUsage, VOICE_DESIGN_FREE_CREDIT_UNITS, STT_CHARS_PER_SECOND } = await modP;
  await reportTtsUsage('u1', 1000);
  await reportSttUsage('u1', 60);
  await reportVoiceDesignUsage('u1', 'job1');
  assert.deepEqual(kit.rpcCalls.map((c) => [c.args.p_units, c.args.p_identifier]), [
    [1000, null],
    [Math.round(60 * STT_CHARS_PER_SECOND), null],
    [VOICE_DESIGN_FREE_CREDIT_UNITS, 'voice-design-job1'],
  ]);
  assert.equal(kit.stripeCalls.length, 0);
}));

test('free user: reportAudioJobUsage deducts billableAudioUnits with a job-scoped identifier', () => withKit(async (kit) => {
  const { reportAudioJobUsage, billableAudioUnits } = await modP;
  await reportAudioJobUsage('u1', 'dub', 90, 'j9', { getBilling: async () => null, createMeterEvent: async () => { throw new Error('must not be called'); }, consumeFreeCredits: async (u, n, id) => { kit.rpcCalls.push({ fn: 'x', args: { u, n, id } }); return n; } });
  assert.deepEqual(kit.rpcCalls[0]!.args, { u: 'u1', n: billableAudioUnits('dub', 90), id: 'dub-j9' });
}));

test('free user: default-deps reportAudioJobUsage goes through consume_free_credits, not Stripe', () => withKit(async (kit) => {
  const { reportAudioJobUsage, billableAudioUnits } = await modP;
  await reportAudioJobUsage('u1', 'sound_effect', 5, 'sfx1');
  assert.equal(kit.rpcCalls[0]!.args.p_units, billableAudioUnits('sound_effect', 5));
  assert.equal(kit.rpcCalls[0]!.args.p_identifier, 'sound-effect-sfx1');
  assert.equal(kit.stripeCalls.length, 0);
}));

test('free user: a job larger than the remaining credits consumes only what is left, never negative, does not throw', () => withKit(async (kit) => {
  const { reportAudioJobUsage } = await modP;
  kit.freeCredits['u1'] = { granted: 10000, used: 9800 };
  await assert.doesNotReject(() => reportAudioJobUsage('u1', 'dub', 600, 'big'));
  assert.equal(kit.freeCredits['u1']!.used, 10000);
}));

test('free user: reportMusicGenerationUsage and chargeForVoiceClone stay payment-only (no deduction, no Stripe)', () => withKit(async (kit) => {
  const { reportMusicGenerationUsage, chargeForVoiceClone } = await modP;
  await reportMusicGenerationUsage('u1');
  const r = await chargeForVoiceClone('u1-with-hyphen');
  assert.equal(r.success, false);
  assert.equal(kit.rpcCalls.length, 0);
  assert.equal(kit.stripeCalls.length, 0);
}));

test('paying user: every reporter still goes to Stripe and never touches free credits', () => withKit(async (kit) => {
  const { reportTtsUsage, reportSttUsage, reportVoiceDesignUsage, reportAudioJobUsage, reportMusicGenerationUsage, chargeForVoiceClone } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u-1' }));
  await reportTtsUsage('u-1', 500);
  await reportSttUsage('u-1', 30);
  await reportVoiceDesignUsage('u-1', 'j');
  await reportAudioJobUsage('u-1', 'isolate', 20, 'j');
  await reportMusicGenerationUsage('u-1');
  const clone = await chargeForVoiceClone('u-1');
  assert.equal(stripeMeterCalls(kit).length, 5);
  assert.equal(kit.stripeCalls.filter((c) => c.name === 'invoiceItems.create').length, 1);
  assert.equal(clone.success, true);
  assert.equal(kit.rpcCalls.length, 0);
}));

test('COMPED user: no reporter calls Stripe or deducts credits (tts, stt, audio job, voice design, music, clone, drain)', () => withKit(async (kit) => {
  const m = await modP;
  kit.tables.realtimetts_billing!.push({ ...COMPED, user_id: 'u-1' });
  kit.tables.realtimetts_api_keys!.push({ user_id: 'u-1', gateway_key_id: 'gk1', revoked_at: null });
  await m.reportTtsUsage('u-1', 500);
  await m.reportSttUsage('u-1', 30);
  await m.reportVoiceDesignUsage('u-1', 'j');
  await m.reportAudioJobUsage('u-1', 'dub', 20, 'j');
  await m.reportVoiceConvertUsage('u-1', 20, 'j');
  await m.reportVoiceIsolateUsage('u-1', 20, 'j');
  await m.reportDubbingUsage('u-1', 20, 'j');
  await m.reportSoundEffectGenerationUsage('u-1', 5, 'j');
  await m.reportMusicGenerationUsage('u-1');
  const clone = await m.chargeForVoiceClone('u-1');
  assert.deepEqual(clone, { success: true });
  assert.equal(kit.stripeCalls.length, 0, 'Stripe must never be called for a comped user');
  assert.equal(kit.rpcCalls.length, 0, 'no free credits deducted for a comped user');
}));

test('COMPED user: gateway usage drain is neither reported to Stripe nor deducted', () => withKit(async (kit) => {
  const { reportUsageToStripe } = await modP;
  const events: unknown[] = [];
  const consumed: unknown[] = [];
  await reportUsageToStripe({
    drain: async () => [{ id: 'gk1', chars: 900 }],
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async () => COMPED as any,
    createMeterEvent: async (p) => { events.push(p); },
    consumeFreeCredits: async (...a) => { consumed.push(a); return 1; },
  });
  assert.equal(events.length, 0);
  assert.equal(consumed.length, 0);
}));

test('drain for a user with no billing deducts free credits instead of dropping usage; paying user still hits Stripe', () => withKit(async () => {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const consumed: any[] = [];
  await reportUsageToStripe({
    drain: async () => [{ id: 'gk1', chars: 900 }, { id: 'gk2', chars: 100 }],
    getKeyOwner: async (id) => ({ user_id: id === 'gk1' ? 'free' : 'paid' }),
    getBilling: async (u) => (u === 'paid' ? (billingRow({ user_id: 'paid' }) as any) : null),
    createMeterEvent: async (p) => { events.push(p); },
    consumeFreeCredits: async (u, n) => { consumed.push([u, n]); return n; },
  });
  assert.deepEqual(consumed, [['free', 900]]);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.value, '100');
}));
