// Run: npm test. STT minimum billed duration (default 10 s per successful request, billing only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, stripeMeterCalls, type Kit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
delete process.env.STT_MIN_BILLED_SECONDS; // default (10) must apply

const modP = import('./realtimeTtsBilling.js');

async function withKit(fn: (kit: Kit) => Promise<void>) {
  const kit = await installKit();
  try { await fn(kit); } finally { kit.restore(); }
}
const meterValue = (kit: Kit, i = 0) => Number((stripeMeterCalls(kit)[i]!.args[0] as any).payload.value);

test('config default is 10 seconds', async () => {
  const { config } = await import('./config.js');
  assert.equal(config.STT_MIN_BILLED_SECONDS, 10);
});

test('billableSttSeconds: 0 / negative / NaN unbilled; 3 -> 10; 10 -> 10; 25 -> 25; min 0 disables', async () => {
  const { billableSttSeconds } = await modP;
  assert.equal(billableSttSeconds(0), 0);
  assert.equal(billableSttSeconds(-1), 0);
  assert.equal(billableSttSeconds(NaN), 0);
  assert.equal(billableSttSeconds(3), 10);
  assert.equal(billableSttSeconds(0.2), 10);
  assert.equal(billableSttSeconds(10), 10);
  assert.equal(billableSttSeconds(25), 25);
  assert.equal(billableSttSeconds(3, 0), 3);
  assert.equal(billableSttSeconds(0, 0), 0);
});

test('free path: 3 s deducts 10 s of units; 10 s and 25 s as-is; 0 s deducts nothing', () => withKit(async (kit) => {
  const { reportSttUsage, STT_CHARS_PER_SECOND } = await modP;
  await reportSttUsage('u1', 0);
  assert.equal(kit.rpcCalls.length, 0);
  await reportSttUsage('u1', 3);
  await reportSttUsage('u1', 10);
  await reportSttUsage('u1', 25);
  assert.deepEqual(kit.rpcCalls.map((c) => c.args.p_units), [
    Math.round(10 * STT_CHARS_PER_SECOND), Math.round(10 * STT_CHARS_PER_SECOND), Math.round(25 * STT_CHARS_PER_SECOND),
  ]);
  assert.equal(kit.stripeCalls.length, 0);
}));

test('Stripe path: 3 s reports 10 s of chars; 10 s and 25 s as-is; 0 s reports nothing', () => withKit(async (kit) => {
  const { reportSttUsage, STT_CHARS_PER_SECOND } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow());
  await reportSttUsage('u1', 0);
  assert.equal(stripeMeterCalls(kit).length, 0);
  await reportSttUsage('u1', 3);
  await reportSttUsage('u1', 10);
  await reportSttUsage('u1', 25);
  assert.equal(stripeMeterCalls(kit).length, 3);
  assert.equal(meterValue(kit, 0), Math.round(10 * STT_CHARS_PER_SECOND));
  assert.equal(meterValue(kit, 1), Math.round(10 * STT_CHARS_PER_SECOND));
  assert.equal(meterValue(kit, 2), Math.round(25 * STT_CHARS_PER_SECOND));
  assert.equal(kit.rpcCalls.length, 0);
}));

test('comped user: no report at any duration', () => withKit(async (kit) => {
  const { reportSttUsage } = await modP;
  kit.tables.realtimetts_billing!.push(billingRow({ comped: true, stripe_customer_id: null, stripe_subscription_id: null, stripe_subscription_item_id: null }));
  await reportSttUsage('u1', 3);
  await reportSttUsage('u1', 25);
  assert.equal(stripeMeterCalls(kit).length, 0);
  assert.equal(kit.rpcCalls.length, 0);
}));
