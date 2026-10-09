// backend/src/lib/realtimeTtsBilling.usageDaily.test.ts
// Run: npm test. The gateway drain also records a per-day usage ledger; billing must be byte-for-byte unchanged by it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, stripeMeterCalls, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');

type Drain = Array<{ id: string; chars: number; piperChars?: number; audioSeconds?: number }>;

async function run(opts: {
  usage: Drain; freeChars?: Array<{ owner: string; chars: number }>; owners?: Record<string, string>;
  active?: Record<string, boolean>; recorder?: ((d: any) => Promise<void>) | null; // null = no recorder at all
}) {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const recorded: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: opts.usage, freeChars: opts.freeChars ?? [] }),
    getKeyOwner: async (id) => (opts.owners?.[id] ? { user_id: opts.owners[id]! } : null),
    getBilling: async (uid) =>
      opts.active && uid in opts.active ? ({ user_id: uid, stripe_customer_id: `cus_${uid}`, active: opts.active[uid] } as any) : null,
    createMeterEvent: async (p) => { events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: opts.recorder === null ? undefined : (opts.recorder ?? (async (d) => { recorded.push(d); })),
  });
  return { events, recorded };
}

test('a paid entry records raw chars, piper chars and audio seconds for the key owner', async () => {
  const { events, recorded } = await run({
    usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true },
  });
  assert.deepEqual(recorded, [{ userId: 'u1', chars: 1000, piperChars: 400, audioSeconds: 30 }]);
  assert.equal(events.length, 1); // the meter event is still created
});

test('the meter event value is identical with and without a recorder', async () => {
  const withRec = await run({ usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true } });
  const noRec = await run({
    usage: [{ id: 'k1', chars: 1000, piperChars: 400, audioSeconds: 30 }], owners: { k1: 'u1' }, active: { u1: true },
    recorder: null,
  });
  assert.equal(withRec.events[0].payload.value, noRec.events[0].payload.value);
});

test('a throwing recorder never stops billing', async () => {
  const { events } = await run({
    usage: [{ id: 'k1', chars: 500 }, { id: 'k2', chars: 700 }], owners: { k1: 'u1', k2: 'u2' }, active: { u1: true, u2: true },
    recorder: async () => { throw new Error('db down'); },
  });
  assert.equal(events.length, 2);
});

test('a comped user is recorded (usage is real) but never billed', async () => {
  const { reportUsageToStripe } = await modP;
  const recorded: any[] = []; const events: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: [{ id: 'k1', chars: 50 }], freeChars: [] }),
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async () => ({ user_id: 'u1', stripe_customer_id: 'cus', active: true, comped: true } as any),
    createMeterEvent: async (p) => { events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: async (d) => { recorded.push(d); },
  });
  assert.equal(events.length, 0);
  assert.equal(recorded.length, 1);
});

test('free-tier usage is recorded per owner as freeChars', async () => {
  const { recorded } = await run({ usage: [], freeChars: [{ owner: 'u9', chars: 321 }] });
  assert.deepEqual(recorded, [{ userId: 'u9', freeChars: 321 }]);
});

test('two keys of one user produce two recorder calls (the SQL function adds them)', async () => {
  const { recorded } = await run({
    usage: [{ id: 'k1', chars: 10 }, { id: 'k2', chars: 20 }], owners: { k1: 'u1', k2: 'u1' }, active: { u1: true },
  });
  assert.deepEqual(recorded.map((r) => r.chars), [10, 20]);
});

test('an entry whose key has no owner is skipped and not recorded', async () => {
  const { recorded } = await run({ usage: [{ id: 'ghost', chars: 10 }], owners: {} });
  assert.equal(recorded.length, 0);
});

// --- reportSttUsage (customer-facing STT billing) records raw audio seconds through the real recorder -------
async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}

test('reportSttUsage records the raw audio seconds for the user and leaves free credits alone for the ledger call', async () => {
  await withKit(async (kit) => {
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 42);
    assert.equal(kit.usageRows.length, 1);
    assert.equal(kit.usageRows[0]!.p_user, 'u1');
    assert.equal(kit.usageRows[0]!.p_audio, 42);
    assert.equal(stripeMeterCalls(kit).length, 1);
    assert.equal(Object.keys(kit.freeCredits).length, 0); // the add-usage rpc must not touch the free-credit fake
  });
});

test('reportSttUsage still bills when recording fails', async () => {
  await withKit(async (kit) => {
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1' }));
    kit.usageRpcError = true;
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 42);
    assert.equal(stripeMeterCalls(kit).length, 1);
  });
});
