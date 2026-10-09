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

test('safeEvent gives up on a hung recorder after the timeout without throwing', async () => {
  const { safeEvent } = await modP;
  const started = Date.now();
  await safeEvent(() => new Promise<void>(() => {}), { kind: 'webhook_failed' }, 50);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40 && elapsed < 1000, `elapsed ${elapsed}ms`);
});

test('safeEvent resolves quickly for a fast recorder', async () => {
  const { safeEvent } = await modP;
  const started = Date.now();
  let called = false;
  await safeEvent(async () => { called = true; }, { kind: 'webhook_failed' });
  assert.ok(called);
  assert.ok(Date.now() - started < 500);
});

async function withDeleteSpy(result: () => { error: { message: string } | null }) {
  const { supabase } = await import('./supabaseClient.js');
  const sb = supabase as any;
  const wrapped = sb.from;
  const calls: any[] = [];
  sb.from = (t: string) => {
    if (t !== 'realtimetts_event_log') return wrapped(t);
    return { delete: () => ({ lt: (col: string, val: string) => { calls.push({ col, val }); return Promise.resolve(result()); } }) };
  };
  return { calls, restore: () => { sb.from = wrapped; } };
}

test('pruneOldEvents deletes rows older than exactly 30 days before now', async () => {
  const spy = await withDeleteSpy(() => ({ error: null }));
  try {
    const { pruneOldEvents } = await modP;
    await pruneOldEvents(new Date('2026-10-09T12:00:00.000Z'));
    assert.deepEqual(spy.calls, [{ col: 'created_at', val: '2026-09-09T12:00:00.000Z' }]);
  } finally { spy.restore(); }
});

test('pruneOldEvents never throws when the delete errors or throws', async () => {
  const errSpy = await withDeleteSpy(() => ({ error: { message: 'db down' } }));
  try {
    const { pruneOldEvents } = await modP;
    await pruneOldEvents(new Date('2026-10-09T12:00:00.000Z'));
  } finally { errSpy.restore(); }
  const throwSpy = await withDeleteSpy(() => { throw new Error('boom'); });
  try {
    const { pruneOldEvents } = await modP;
    await pruneOldEvents(new Date('2026-10-09T12:00:00.000Z'));
  } finally { throwSpy.restore(); }
});
