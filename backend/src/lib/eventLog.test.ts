// backend/src/lib/eventLog.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { installKit } from '../../test/billingKit.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./eventLog.js');

test('recordEvent inserts kind, user and a clipped detail', async () => {
  const kit = await installKit();
  try {
    const { recordEvent } = await modP;
    await recordEvent({ kind: 'usage_report_failed', userId: 'u1', detail: 'x'.repeat(500) });
    const rows = kit.tables.realtimetts_event_log!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, 'usage_report_failed');
    assert.equal(rows[0]!.user_id, 'u1');
    assert.equal(rows[0]!.detail.length, 200);
  } finally { kit.restore(); }
});

test('recordEvent stores a null user and an empty detail when omitted', async () => {
  const kit = await installKit();
  try {
    const { recordEvent } = await modP;
    await recordEvent({ kind: 'webhook_failed' });
    const r = kit.tables.realtimetts_event_log![0]!;
    assert.equal(r.user_id, null);
    assert.equal(r.detail, '');
  } finally { kit.restore(); }
});

test('safeEvent never throws, with a throwing recorder or none', async () => {
  const { safeEvent } = await modP;
  await safeEvent(async () => { throw new Error('db down'); }, { kind: 'webhook_failed' });
  await safeEvent(undefined, { kind: 'webhook_failed' });
});

test('safeEvent does not wait forever on a hung recorder', async () => {
  const { safeEvent } = await modP;
  const started = Date.now();
  await Promise.race([
    safeEvent(() => new Promise<void>(() => {}), { kind: 'webhook_failed' }),
    new Promise((r) => setTimeout(r, 3500)),
  ]);
  assert.ok(Date.now() - started < 3600);
});
