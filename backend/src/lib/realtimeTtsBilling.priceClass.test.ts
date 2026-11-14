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

// --- the generated registry copy (src/generated/ttsRegistry.json) ---
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const generatedPath = fileURLToPath(new URL('../generated/ttsRegistry.json', import.meta.url));
const scriptPath = fileURLToPath(new URL('../../scripts/sync-tts-registry.mjs', import.meta.url));

test('the default registry view is the generated copy, under registry ids and public aliases, and it agrees with the price-class table', async () => {
  const { ENGINE_REGISTRY, REGISTRY_HASH, ENGINE_PRICE_CLASS, priceClassForEngine } = await modP;
  const gen = JSON.parse(readFileSync(generatedPath, 'utf8'));
  assert.equal(REGISTRY_HASH, gen.registry.hash);
  assert.match(REGISTRY_HASH, /^[0-9a-f]{16}$/);
  for (const [id, e] of Object.entries<any>(gen.engines)) {
    assert.equal(ENGINE_REGISTRY[id]?.hardware, e.hardware, id);
    if (e.public_alias) assert.equal(ENGINE_REGISTRY[e.public_alias]?.hardware, e.hardware, e.public_alias);
    // The registry's price class and what billing computes for that engine must be the same, or the table and the registry have drifted.
    assert.equal(priceClassForEngine(id), e.price_class, id);
    if (e.public_alias) assert.equal(priceClassForEngine(e.public_alias), e.price_class, e.public_alias);
    // Known names in the table must also agree with the registry's hardware rule.
    for (const name of [id, e.public_alias]) if (name && ENGINE_PRICE_CLASS[name]) assert.equal(ENGINE_PRICE_CLASS[name], e.hardware === 'cpu' ? 'live' : 'studio', name);
  }
});

test('WHY a new engine must not be enabled before the backend has the generated copy and the gateway sends usage_by_engine', async () => {
  const { billableChars } = await modP;
  // The registry the backend shipped with does not know "newcpu" (it was added to the registry after the last sync).
  const shipped = { piper: { hardware: 'cpu' }, kokoro: { hardware: 'gpu' } };
  // (1) Gateway reports its characters per engine, but the backend copy is stale: billed at the studio rate, 2.5x what a CPU engine should cost.
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { newcpu: 1000 } }, shipped), 1000);
  // (2) Backend copy is current but the gateway has no usage_by_engine yet: the characters sit in `chars` with no attribution (piperChars
  //     only covers Piper), so they also bill at the studio rate.
  assert.equal(billableChars({ chars: 1000, piperChars: 0 }, { ...shipped, newcpu: { hardware: 'cpu' } }), 1000);
  // Only both together bill it at the live rate.
  assert.equal(billableChars({ chars: 1000, usage_by_engine: { newcpu: 1000 } }, { ...shipped, newcpu: { hardware: 'cpu' } }), 400);
});

test('an engine missing from the (shipped, generated) registry bills as studio', async () => {
  const { billableChars, priceClassForEngine } = await modP;
  assert.equal(priceClassForEngine('definitely-not-registered'), 'studio');
  assert.equal(billableChars({ chars: 500, usage_by_engine: { 'definitely-not-registered': 500 } }), 500);
});

test('sync --check passes against the registry in TTS_REGISTRY_DIR when it is available (run this in CI before enabling an engine)',
  { skip: !process.env.TTS_REGISTRY_DIR || !existsSync(process.env.TTS_REGISTRY_DIR || '') }, () => {
    const r = spawnSync(process.execPath, [scriptPath, '--check'], { env: process.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

test('the sync script refuses a price class it has no ratio for and one that contradicts the hardware', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const mod: any = await import(scriptPath);
  const mk = (engines: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ttsreg-'));
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist/registry.json'), JSON.stringify({ version: 1, hash: 'abcdef0123456789', engines }));
    return dir;
  };
  const cases: Array<[RegExp, Record<string, unknown>]> = [
    [/no ratio/, { x: { hardware: 'cpu', price_class: 'premium', public_alias: 'x' } }],
    [/disagrees with hardware/, { x: { hardware: 'gpu', price_class: 'live', public_alias: 'x' } }],
    [/hardware must be cpu or gpu/, { x: { hardware: 'tpu', price_class: 'live' } }],
  ];
  for (const [re, engines] of cases) {
    const dir = mk(engines);
    try { assert.throws(() => mod.build(dir), re); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const ok = mk({ a: { hardware: 'cpu', price_class: 'live', public_alias: 'al' }, b: { hardware: 'gpu', price_class: 'studio' } });
  try {
    const out = mod.build(ok);
    assert.deepEqual(out.engines, { a: { public_alias: 'al', hardware: 'cpu', price_class: 'live' }, b: { public_alias: null, hardware: 'gpu', price_class: 'studio' } });
    assert.equal(out.registry.hash, 'abcdef0123456789');
  } finally { rmSync(ok, { recursive: true, force: true }); }
});
