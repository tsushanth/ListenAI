// Run: npm test   (node:test via tsx). Stripe and the gateway drain are mocked through UsageReportDeps.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';   // logger only loads pino-pretty in development

const modP = import('./realtimeTtsBilling.js');   // after env is set; no top-level await (CJS build)
type Deps = import('./realtimeTtsBilling.js').UsageReportDeps;

interface Setup {
  usage: Array<{ id: string; chars: number; piperChars?: number; audioSeconds?: number }>;
  owners?: Record<string, string>;            // gatewayKeyId -> userId
  active?: Record<string, boolean>;           // userId -> billing active (absent = no billing row)
  failStripe?: boolean;
}
async function run(s: Setup) {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const deps: Deps = {
    drain: async () => s.usage,
    getKeyOwner: async (id) => (s.owners?.[id] ? { user_id: s.owners[id]! } : null),
    getBilling: async (uid) =>
      s.active && uid in s.active ? ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: s.active[uid] } as any) : null,
    createMeterEvent: async (p) => {
      if (s.failStripe) throw new Error('stripe down');
      events.push(p);
      return {};
    },
  };
  await reportUsageToStripe(deps);
  return events;
}
const one = (u: Setup['usage'][number]) => run({ usage: [u], owners: { k: 'u1' }, active: { u1: true } });

test('constant is 11,000 char-equivalents per hour', async () => {
  const { STT_CHARS_PER_SECOND } = await modP;
  assert.equal(Math.round(STT_CHARS_PER_SECOND * 3600), 11000);
  assert.equal(STT_CHARS_PER_SECOND, 3.0556);
});

test('chars only: unchanged behaviour', async () => {
  const ev = await one({ id: 'k', chars: 1234, piperChars: 0, audioSeconds: 0 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_name, 'realtimetts_characters');
  assert.equal(ev[0].payload.value, '1234');
  assert.equal(ev[0].payload.stripe_customer_id, 'cus_u1');
});

test('legacy gateway entry without audioSeconds/piperChars', async () => {
  assert.equal((await one({ id: 'k', chars: 500 }))[0].payload.value, '500');
});

test('piper weighting: chars is the total, piper subset at 0.4', async () => {
  // 1000 total of which 500 piper -> 500 + 200
  assert.equal((await one({ id: 'k', chars: 1000, piperChars: 500 }))[0].payload.value, '700');
  // piper only
  assert.equal((await one({ id: 'k', chars: 100, piperChars: 100 }))[0].payload.value, '40');
});

test('audio only: 1 hour = 11000, 60 s = 183', async () => {
  assert.equal((await one({ id: 'k', chars: 0, piperChars: 0, audioSeconds: 3600 }))[0].payload.value, '11000');
  assert.equal((await one({ id: 'k', chars: 0, audioSeconds: 60 }))[0].payload.value, '183'); // 183.336
});

test('combo of all three', async () => {
  // (1000-400) + 400*0.4 = 760 ; 100.5 s * 3.0556 = 307.09 -> 307 ; total 1067
  assert.equal((await one({ id: 'k', chars: 1000, piperChars: 400, audioSeconds: 100.5 }))[0].payload.value, '1067');
});

test('rounding', async () => {
  const { billableChars } = await modP;
  assert.equal(billableChars({ chars: 0, audioSeconds: 0.16 }), 0);   // 0.489 -> 0
  assert.equal(billableChars({ chars: 0, audioSeconds: 0.17 }), 1);   // 0.519 -> 1
  assert.equal(billableChars({ chars: 3, piperChars: 1 }), 2);        // 2 + 0.4 -> 2
  assert.equal(billableChars({ chars: 4, piperChars: 2 }), 3);        // 2 + 0.8 -> 3
  assert.equal(billableChars({ chars: 0, audioSeconds: 12.345 }), Math.round(12.345 * 3.0556)); // 38
});

test('zero values send no meter event', async () => {
  assert.deepEqual(await one({ id: 'k', chars: 0, piperChars: 0, audioSeconds: 0 }), []);
  assert.deepEqual(await one({ id: 'k', chars: 0, audioSeconds: 0.1 }), []);
});

test('empty drain does nothing', async () => {
  assert.deepEqual(await run({ usage: [] }), []);
});

test('users without active billing / unknown keys are dropped', async () => {
  const ev = await run({
    usage: [{ id: 'a', chars: 10 }, { id: 'b', chars: 0, audioSeconds: 500 }, { id: 'c', chars: 10 }, { id: 'd', chars: 7 }],
    owners: { a: 'inactive', b: 'nobilling', d: 'ok' },   // c has no owner record
    active: { inactive: false, ok: true },                 // 'nobilling' has no row
  });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.value, '7');
  assert.equal(ev[0].payload.stripe_customer_id, 'cus_ok');
});

test('multiple keys reported independently, one Stripe failure does not stop the rest', async () => {
  const usage = [{ id: 'k1', chars: 5, audioSeconds: 10 }, { id: 'k2', chars: 0, audioSeconds: 3600 }];
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  let n = 0;
  await reportUsageToStripe({
    drain: async () => usage,
    getKeyOwner: async (id) => ({ user_id: id === 'k1' ? 'u1' : 'u2' }),
    getBilling: async (uid) => ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: true } as any),
    createMeterEvent: async (p) => { if (n++ === 0) throw new Error('boom'); events.push(p); return {}; },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.stripe_customer_id, 'cus_u2');
  assert.equal(events[0].payload.value, '11000');
});

// ---------------------------------------------------------------------------
// Per-audio-minute billing for dub / isolate / convert / sound effects
// ---------------------------------------------------------------------------

test('billableAudioUnits: exact whole minutes match the published per-minute prices', async () => {
  const { billableAudioUnits, METER_USD_PER_UNIT } = await modP;
  const usd = (svc: any, secs: number) => billableAudioUnits(svc, secs) * METER_USD_PER_UNIT;
  assert.equal(billableAudioUnits('dub', 60), 15000);          // $0.15/min
  assert.equal(billableAudioUnits('isolate', 60), 5000);       // $0.05/min
  assert.equal(billableAudioUnits('convert', 60), 10000);      // $0.10/min
  assert.equal(billableAudioUnits('sound_effect', 60), 9000);  // $0.09/min
  assert.ok(Math.abs(usd('dub', 600) - 1.5) < 1e-9);           // 10 min dub = $1.50
  assert.ok(Math.abs(usd('isolate', 600) - 0.5) < 1e-9);       // 10 min (the isolate cap) = $0.50
});

test('billableAudioUnits: scales with length, so a long file can no longer cost the same as a short one', async () => {
  const { billableAudioUnits } = await modP;
  // Previously every isolate job was a flat $0.05 = 5000 units whatever the length.
  assert.equal(billableAudioUnits('isolate', 600), 50000);
  assert.ok(billableAudioUnits('isolate', 600) > 9 * billableAudioUnits('isolate', 60));
  // ~1 hour of audio dubbed
  assert.equal(billableAudioUnits('dub', 3600), 900000);
});

test('billableAudioUnits: rounds up to the next whole second', async () => {
  const { billableAudioUnits } = await modP;
  assert.equal(billableAudioUnits('isolate', 60.01), Math.round((61 * 5000) / 60)); // 61 s billed
  assert.equal(billableAudioUnits('isolate', 60), Math.round((60 * 5000) / 60));
  assert.equal(billableAudioUnits('isolate', 60.0000000001), 5000);                 // float noise is not a whole extra second
  assert.equal(billableAudioUnits('sound_effect', 4.2), Math.round((5 * 9000) / 60)); // 5 s * 150/s = 750
  assert.equal(billableAudioUnits('sound_effect', 12), 1800);                       // 12 s = $0.018
});

test('billableAudioUnits: minimums and unusable durations bill the minimum, never zero', async () => {
  const { billableAudioUnits } = await modP;
  assert.equal(billableAudioUnits('isolate', 0.5), Math.round((10 * 5000) / 60));    // 10 s minimum
  assert.equal(billableAudioUnits('convert', 5), 5000);                              // 30 s minimum = $0.05
  assert.equal(billableAudioUnits('sound_effect', 1), Math.round((4 * 9000) / 60));  // 4 s minimum = $0.006
  for (const bad of [0, -3, NaN, Infinity, null, undefined]) {
    assert.equal(billableAudioUnits('dub', bad as any), 2500, `dub duration ${String(bad)}`); // 10 s minimum
  }
});

test('billableAudioUnits: every price stays >= 2.5x its documented cost and below ElevenLabs', async () => {
  const { AUDIO_JOB_PRICING, METER_USD_PER_UNIT } = await modP;
  const usdPerMin = (svc: any) => AUDIO_JOB_PRICING[svc as 'dub'].unitsPerMinute * METER_USD_PER_UNIT;
  // cost per audio-minute (see the pricing comment in realtimeTtsBilling.ts) and ElevenLabs list price
  const table: Array<[string, number, number]> = [
    ['dub', 0.0520, 0.33],        // STT 0.0005 + translation ~0.0075 + TTS 0.044; EL dubbing $0.33-0.50
    ['isolate', 0.016, 0.12],     // worker-demucs-fly/PRICING.md floor
    ['convert', 0.0293, 0.12],    // ~48 A10G-s per 30 s job at $0.0003056/s = $0.0293/min
  ];
  for (const [svc, cost, eleven] of table) {
    const p = usdPerMin(svc);
    assert.ok(p >= 2.5 * cost, `${svc}: $${p}/min vs cost $${cost}/min`);
    assert.ok(p < eleven, `${svc}: $${p}/min must undercut ElevenLabs $${eleven}/min`);
  }
  assert.ok(usdPerMin('sound_effect') < 0.12);
});

test('reportAudioJobUsage: sends one meter event on the shared character meter with the weighted value', async () => {
  const { reportAudioJobUsage } = await modP;
  const events: any[] = [];
  await reportAudioJobUsage('u1', 'isolate', 120, 'job-1', {
    getBilling: async (uid) => ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: true } as any),
    createMeterEvent: async (p) => { events.push(p); return {}; },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_name, 'realtimetts_characters');
  assert.equal(events[0].payload.stripe_customer_id, 'cus_u1');
  assert.equal(events[0].payload.value, '10000');          // 2 min * $0.05 = $0.10 = 10,000 units
  assert.equal(events[0].identifier, 'voice-isolate-job-1');     // lets Stripe dedupe a re-reported job
});

test('reportAudioJobUsage: no active billing sends nothing; a Stripe failure does not throw', async () => {
  const { reportAudioJobUsage } = await modP;
  const events: any[] = [];
  await reportAudioJobUsage('u1', 'dub', 60, 'j', {
    getBilling: async () => null,
    createMeterEvent: async (p) => { events.push(p); return {}; },
  });
  await reportAudioJobUsage('u1', 'dub', 60, 'j', {
    getBilling: async () => ({ stripe_customer_id: 'cus', active: false } as any),
    createMeterEvent: async (p) => { events.push(p); return {}; },
  });
  assert.equal(events.length, 0);
  await assert.doesNotReject(reportAudioJobUsage('u1', 'convert', 60, 'j', {
    getBilling: async () => ({ stripe_customer_id: 'cus', active: true } as any),
    createMeterEvent: async () => { throw new Error('stripe down'); },
  }));
});
