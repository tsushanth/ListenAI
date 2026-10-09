// backend/src/lib/realtimeTtsBilling.eventLog.test.ts
// Run: npm test. Failed Stripe meter reports are logged fire-and-forget; billing behaviour must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./realtimeTtsBilling.js');

async function run(opts: { failMeter?: boolean; recorder?: ((e: any) => Promise<void>) | null }) {
  const { reportUsageToStripe } = await modP;
  const events: any[] = [];
  const logged: any[] = [];
  await reportUsageToStripe({
    drain: async () => ({ usage: [{ id: 'k1', chars: 1000 }], freeChars: [] }),
    getKeyOwner: async () => ({ user_id: 'u1' }),
    getBilling: async () => ({ user_id: 'u1', stripe_customer_id: 'cus_u1', active: true } as any),
    createMeterEvent: async (p) => { if (opts.failMeter) throw new Error('stripe 500'); events.push(p); return {}; },
    consumeFreeCredits: async () => 0,
    recordUsage: async () => {},
    recordEvent: opts.recorder === null ? undefined : (opts.recorder ?? (async (e) => { logged.push(e); })),
  });
  await new Promise((r) => setImmediate(r));
  return { events, logged };
}

test('a failed Stripe meter report logs usage_report_failed for the key owner', async () => {
  const { logged } = await run({ failMeter: true });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].kind, 'usage_report_failed');
  assert.equal(logged[0].userId, 'u1');
  assert.match(logged[0].detail, /stripe 500/);
});

test('a successful report logs nothing', async () => {
  const { logged, events } = await run({});
  assert.equal(events.length, 1);
  assert.deepEqual(logged, []);
});

test('a throwing or missing event recorder never changes billing', async () => {
  const bad = await run({ recorder: async () => { throw new Error('db down'); } });
  const none = await run({ recorder: null });
  assert.equal(bad.events.length, 1);
  assert.equal(none.events.length, 1);
});

test('a failed STT meter report logs usage_report_failed', async () => {
  const kit = await installKit();
  try {
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u1', active: true }));
    kit.stripeThrows['meterEvents.create'] = new Error('stripe 500');
    const { reportSttUsage } = await modP;
    await reportSttUsage('u1', 60);
    await new Promise((r) => setImmediate(r));
    const rows = kit.tables.realtimetts_event_log ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'usage_report_failed');
  } finally { kit.restore(); }
});
