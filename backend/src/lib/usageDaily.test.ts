import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./usageDaily.js');
const supaP = import('./supabaseClient.js');

async function withRpc(impl: (fn: string, args: any) => Promise<any>, fn: (calls: any[]) => Promise<void>) {
  const { supabase } = await supaP;
  const sb = supabase as any;
  const orig = sb.rpc;
  const calls: any[] = [];
  sb.rpc = async (name: string, args: any) => { calls.push({ name, args }); return impl(name, args); };
  try { await fn(calls); } finally { sb.rpc = orig; }
}

test('utcDay uses the UTC date, not local time', async () => {
  const { utcDay } = await modP;
  assert.equal(utcDay(new Date('2026-10-08T23:59:59Z')), '2026-10-08');
  assert.equal(utcDay(new Date('2026-10-09T00:00:00Z')), '2026-10-09');
});

test('recordUsageDaily calls realtimetts_add_usage with rounded integers and zero defaults', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: null }), async (calls) => {
    await recordUsageDaily({ userId: 'u1', chars: 120.4, piperChars: 20, audioSeconds: 12.5 }, new Date('2026-10-08T10:00:00Z'));
    assert.deepEqual(calls[0], {
      name: 'realtimetts_add_usage',
      args: { p_day: '2026-10-08', p_user: 'u1', p_chars: 120, p_piper: 20, p_audio: 12.5, p_free: 0 },
    });
  });
});

test('recordUsageDaily skips all-zero deltas and negative/NaN values', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: null }), async (calls) => {
    await recordUsageDaily({ userId: 'u1' });
    await recordUsageDaily({ userId: 'u1', chars: -5, audioSeconds: NaN, freeChars: 0 });
    assert.equal(calls.length, 0);
  });
});

test('recordUsageDaily throws on a database error', async () => {
  const { recordUsageDaily } = await modP;
  await withRpc(async () => ({ data: null, error: { message: 'boom' } }), async () => {
    await assert.rejects(() => recordUsageDaily({ userId: 'u1', chars: 5 }), /boom/);
  });
});

test('safeRecord never throws, and is a no-op without a recorder', async () => {
  const { safeRecord } = await modP;
  await safeRecord(undefined, { userId: 'u1', chars: 5 });
  await safeRecord(async () => { throw new Error('down'); }, { userId: 'u1', chars: 5 });
  let seen: any = null;
  await safeRecord(async (d) => { seen = d; }, { userId: 'u2', freeChars: 9 });
  assert.deepEqual(seen, { userId: 'u2', freeChars: 9 });
});

test('safeRecord resolves when the recorder throws synchronously', async () => {
  const { safeRecord } = await modP;
  await safeRecord((() => { throw new Error('x'); }) as any, { userId: 'u1', chars: 5 });
});

test('safeRecord resolves when the recorder rejects with a non-Error', async () => {
  const { safeRecord } = await modP;
  await safeRecord((() => Promise.reject(null)) as any, { userId: 'u1', chars: 5 });
  await safeRecord((() => Promise.reject('plain string')) as any, { userId: 'u1', chars: 5 });
});
