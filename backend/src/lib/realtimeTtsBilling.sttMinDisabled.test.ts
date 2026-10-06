// Run: npm test. STT_MIN_BILLED_SECONDS=0 disables the minimum (own file: config is read at import time).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit, billingRow, stripeMeterCalls } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.STT_MIN_BILLED_SECONDS = '0';

const modP = import('./realtimeTtsBilling.js');

test('env 0 disables the minimum on both paths; 0 s still unbilled', async () => {
  const { reportSttUsage, STT_CHARS_PER_SECOND } = await modP;
  const { config } = await import('./config.js');
  assert.equal(config.STT_MIN_BILLED_SECONDS, 0);
  const kit = await installKit();
  try {
    await reportSttUsage('u1', 3);
    await reportSttUsage('u1', 0);
    assert.deepEqual(kit.rpcCalls.map((c) => c.args.p_units), [Math.round(3 * STT_CHARS_PER_SECOND)]);
    kit.tables.realtimetts_billing!.push(billingRow({ user_id: 'u2' }));
    await reportSttUsage('u2', 3);
    assert.equal(stripeMeterCalls(kit).length, 1);
    assert.equal(Number((stripeMeterCalls(kit)[0]!.args[0] as any).payload.value), Math.round(3 * STT_CHARS_PER_SECOND));
  } finally { kit.restore(); }
});
