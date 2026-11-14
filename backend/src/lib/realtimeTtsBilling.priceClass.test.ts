// Run: npm test   (node:test via tsx). Proves the price-class table bills exactly what the single Piper ratio did,
// and that a new engine can never be billed by omission.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');
type Deps = import('./realtimeTtsBilling.js').UsageReportDeps;

// Golden amounts: the pre-change function was
//   Math.round((chars - piperChars) + piperChars * 0.4) + Math.round(audioSeconds * 3.0556)
// These numbers are what that function returned; they must never move without a price decision.
test('golden: Live (Piper subset) and Studio amounts are unchanged', async () => {
  const { billableChars, PRICE_CLASS_RATIO } = await modP;
  assert.deepEqual({ ...PRICE_CLASS_RATIO }, { live: 0.4, studio: 1.0 });
  // $0.004 per 1,000 Live chars = 400 meter units at $0.00001 each; $0.01 per 1,000 Studio chars = 1,000 units.
  assert.equal(billableChars({ chars: 1000, piperChars: 1000 }), 400);
  assert.equal(billableChars({ chars: 1000, piperChars: 0 }), 1000);
  assert.equal(billableChars({ chars: 1000 }), 1000);
  assert.equal(billableChars({ chars: 1000, piperChars: 500 }), 700);
  assert.equal(billableChars({ chars: 100, piperChars: 100 }), 40);
  assert.equal(billableChars({ chars: 1_000_000, piperChars: 1_000_000 }), 400_000);
  assert.equal(billableChars({ chars: 1_000_000 }), 1_000_000);
  assert.equal(billableChars({ chars: 3, piperChars: 1 }), 2);
  assert.equal(billableChars({ chars: 4, piperChars: 2 }), 3);
  assert.equal(billableChars({ chars: 1000, piperChars: 400, audioSeconds: 100.5 }), 1067);
  assert.equal(billableChars({ chars: 0, audioSeconds: 3600 }), 11000);
});

test('golden: the new function equals the old formula over a sweep of inputs', async () => {
  const { billableChars } = await modP;
  const old = (u: { chars: number; piperChars?: number; audioSeconds?: number }) => {
    const { chars, piperChars = 0, audioSeconds = 0 } = u;
    return Math.round((chars - piperChars) + piperChars * 0.4) + Math.round(audioSeconds * 3.0556);
  };
  for (let chars = 0; chars <= 2000; chars += 37) {
    for (let piper = 0; piper <= chars; piper += 53) {
      for (const audioSeconds of [0, 0.16, 0.17, 12.345, 100.5, 3600]) {
        assert.equal(billableChars({ chars, piperChars: piper, audioSeconds }), old({ chars, piperChars: piper, audioSeconds }), `${chars}/${piper}/${audioSeconds}`);
      }
    }
  }
});

test('known engine ids: live/piper are the live class, studio/kokoro the studio class', async () => {
  const { priceClassForEngine } = await modP;
  assert.equal(priceClassForEngine('live'), 'live');
  assert.equal(priceClassForEngine('piper'), 'live');
  assert.equal(priceClassForEngine('studio'), 'studio');
  assert.equal(priceClassForEngine('kokoro'), 'studio');
});

test('unknown cpu engine bills as live; unknown gpu engine, and an engine nobody registered, bill as studio', async () => {
  const { priceClassForEngine, billableChars } = await modP;
  const registry = { newcpu: { hardware: 'cpu' }, newgpu: { hardware: 'gpu' } };
  assert.equal(priceClassForEngine('newcpu', registry), 'live');
  assert.equal(priceClassForEngine('newgpu', registry), 'studio');
  assert.equal(priceClassForEngine('nobody-registered', registry), 'studio');
  assert.equal(priceClassForEngine('newcpu', {}), 'studio'); // no registry entry: documented default
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { newcpu: 1000 } }, registry), 400);
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { newgpu: 1000 } }, registry), 1000);
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { 'nobody-registered': 1000 } }, registry), 1000);
});

test('registry keys like __proto__ / constructor never resolve through the prototype chain', async () => {
  const { priceClassForEngine } = await modP;
  assert.equal(priceClassForEngine('constructor', {}), 'studio');
  assert.equal(priceClassForEngine('__proto__', {}), 'studio');
  assert.equal(priceClassForEngine('toString', { toString: { hardware: 'cpu' } }), 'live'); // an own entry still works
});

test('usage_by_engine is optional: absent, empty or unusable falls back to the piperChars arithmetic', async () => {
  const { billableChars } = await modP;
  const base = { chars: 1000, piperChars: 500 };
  assert.equal(billableChars(base), 700);
  assert.equal(billableChars({ ...base, usage_by_engine: undefined }), 700);
  assert.equal(billableChars({ ...base, usage_by_engine: null }), 700);
  assert.equal(billableChars({ ...base, usage_by_engine: {} }), 700);
  assert.equal(billableChars({ ...base, usage_by_engine: { piper: -5, kokoro: Number.NaN } }), 700);
  assert.equal(billableChars({ ...base, usage_by_engine: [1, 2] as unknown as Record<string, number> }), 700);
});

test('usage_by_engine present: it is the authority, piperChars is not double counted', async () => {
  const { billableChars } = await modP;
  // Same split as piperChars=500 of 1000, so the same amount, with and without the legacy field.
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { piper: 500, kokoro: 500 } }), 700);
  assert.equal(billableChars({ chars: 1000, piperChars: 500, usage_by_engine: { piper: 500, kokoro: 500 } }), 700);
  assert.equal(billableChars({ chars: 1000, piperChars: 500, usage_by_engine: { live: 500, studio: 500 } }), 700);
  // Characters no engine claims bill at the studio rate; claimed > chars is not clamped away.
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { piper: 500 } }), 700);
  assert.equal(billableChars({ chars: 100, usage_by_engine: { piper: 500 } }), 200);
  // STT audio is still added on top.
  assert.equal(billableChars({ chars: 1000, audioSeconds: 3600, usage_by_engine: { piper: 1000 } }), 400 + 11000);
});

test('end to end through reportUsageToStripe: a drained entry with usage_by_engine is billed by price class, a legacy one is unchanged', async () => {
  const { reportUsageToStripe } = await modP;
  const events: Array<{ payload: { value: string } }> = [];
  const mk = (usage: unknown[]): Deps => ({
    drain: async () => usage as never,
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async (uid: string) => ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: true } as never),
    createMeterEvent: async (p) => { events.push(p as never); return {}; },
    consumeFreeCredits: async () => 0,
  });
  await reportUsageToStripe(mk([{ id: 'k', chars: 1000, piperChars: 400 }]));
  await reportUsageToStripe(mk([{ id: 'k', chars: 1000, piperChars: 400, usage_by_engine: { piper: 400, kokoro: 600 } }]));
  assert.deepEqual(events.map((e) => e.payload.value), ['760', '760']);
});
