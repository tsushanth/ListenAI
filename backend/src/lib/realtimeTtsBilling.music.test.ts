// Run: npx tsx --test src/lib/realtimeTtsBilling.music.test.ts
// reportMusicGenerationUsage follows the same (non-injectable) best-effort shape as
// reportVoiceDesignUsage/reportVoiceConvertUsage in realtimeTtsBilling.ts — it talks
// to the real `stripe` client and `getBillingForUser` directly, so there's no seam to
// mock the Stripe call itself. What we can and must verify is the contract that matters
// to callers (Task 10's musicJobWorker): it never throws, even when nothing behind it
// (Supabase lookup, Stripe) is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test'; // logger only loads pino-pretty in development

const modP = import('./realtimeTtsBilling.js'); // after env is set; no top-level await (CJS build)

test('reportMusicGenerationUsage does not throw when the Stripe call fails (best-effort)', async () => {
  const { reportMusicGenerationUsage } = await modP;
  await assert.doesNotReject(() => reportMusicGenerationUsage('00000000-0000-0000-0000-000000000001'));
});

test('MUSIC_GENERATION_METER_EVENT_NAME is exported and set', async () => {
  const { MUSIC_GENERATION_METER_EVENT_NAME } = await modP;
  assert.equal(MUSIC_GENERATION_METER_EVENT_NAME, 'realtimetts_music_generations');
});

test('reportMusicGenerationUsage swallows a Stripe meterEvents.create failure and does not throw (try/catch path)', async () => {
  await modP;

  // There's no DI seam for either `stripe` or `getBillingForUser` in
  // realtimeTtsBilling.ts (both are plain, mutable module-level objects/
  // functions, imported directly rather than injected), so to actually
  // reach the try/catch around stripe.billing.meterEvents.create we have to
  // monkey-patch at the object level for the duration of this one test:
  //   1. `supabase.from` is patched so the `realtimetts_billing` lookup
  //      inside getBillingForUser resolves to a truthy, active billing row
  //      without needing a real Supabase user — this is what gets us past
  //      the early `if (!billing?.active) return;` guard.
  //   2. `stripe.billing.meterEvents.create` (imported via the default
  //      `stripe` package) is patched to reject, so we exercise the real
  //      try/catch rather than mocking it away.
  // Both patches are restored in `finally` so they can't leak into other
  // tests/files (node:test files here don't share a module cache across
  // files, but they do within this file, and this file has a second test
  // above that also imports the same singletons).
  const { supabase } = await import('./supabaseClient.js');
  // Deliberately `require`, not `import()`: the `stripe` package is a dual
  // CJS/ESM package, and this test file (and realtimeTtsBilling.ts, once
  // compiled) load it via the CJS build. A dynamic `import('stripe')` here
  // resolves the *ESM* build instead — a different class with a different
  // prototype — so patching that copy's prototype silently misses the
  // instance realtimeTtsBilling.ts actually constructs. `require` guarantees
  // we patch the same class the module under test uses.
  const Stripe = require('stripe');

  const fakeBillingRow = {
    id: 'fake-billing-row',
    user_id: '00000000-0000-0000-0000-000000000001',
    stripe_customer_id: 'cus_fake_test',
    stripe_subscription_id: 'sub_fake_test',
    stripe_subscription_item_id: 'si_fake_test',
    active: true,
  };

  const originalFrom = supabase.from.bind(supabase);
  const patchedFrom = ((table: string, ...rest: unknown[]) => {
    if (table === 'realtimetts_billing') {
      const chainable = {
        select() {
          return chainable;
        },
        eq() {
          return chainable;
        },
        maybeSingle: async () => ({ data: fakeBillingRow, error: null }),
      };
      return chainable;
    }
    return (originalFrom as (...args: unknown[]) => unknown)(table, ...rest);
  }) as typeof supabase.from;
  (supabase as unknown as { from: typeof supabase.from }).from = patchedFrom;

  // The module under test constructs its own private `Stripe` instance
  // (`const stripe = new Stripe(...)`), which we have no direct handle on.
  // But `stripe.billing.meterEvents` is itself an instance of a shared
  // resource class — every `Stripe` instance's `billing.meterEvents` object
  // shares the same prototype — so patching `create` on that prototype
  // affects every instance, including the module's private one, without
  // needing a reference to it.
  const probeStripe = new Stripe('sk_test_probe');
  const meterEventsProto = Object.getPrototypeOf(probeStripe.billing.meterEvents);
  const originalCreate = meterEventsProto.create;
  let createCallCount = 0;
  meterEventsProto.create = async () => {
    createCallCount += 1;
    throw new Error('simulated Stripe outage');
  };

  try {
    const { reportMusicGenerationUsage } = await modP;
    await assert.doesNotReject(() =>
      reportMusicGenerationUsage('00000000-0000-0000-0000-000000000001')
    );
    // Guard against this test silently degrading back into exercising only
    // the early-return path (e.g. if the supabase.from patch above stops
    // matching): the try/catch is only actually proven if our stub really
    // got called.
    assert.equal(createCallCount, 1, 'expected the patched stripe.billing.meterEvents.create to be called exactly once');
  } finally {
    (supabase as unknown as { from: typeof supabase.from }).from = originalFrom;
    meterEventsProto.create = originalCreate;
  }
});
