// npm test (node:test via tsx). Shadow-mode usage recording: validation, failure isolation, RPC shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import './modalDeploymentsTestEnv.js'; // must stay first: sets env before config loads
import { recordModalUsage, createSupabaseUsageRecorder, type UsageEventInput, type UsageRecorder } from './modalUsage.js';

const base: UsageEventInput = { deploymentId: 'dep-1', userId: 'user-a', service: 'convert', jobId: 'job-1', gpuSeconds: 12.34567 };

function fakeRecorder(result = true) {
  const seen: UsageEventInput[] = [];
  const r: UsageRecorder = { record: async (ev) => { seen.push(ev); return result; } };
  return { r, seen };
}

test('a valid event is recorded, rounded to milliseconds, and the recorder\'s answer is returned', async () => {
  const { r, seen } = fakeRecorder(true);
  assert.equal(await recordModalUsage(base, r), true);
  assert.equal(seen[0].gpuSeconds, 12.346);
  const dup = fakeRecorder(false);
  assert.equal(await recordModalUsage(base, dup.r), false, 'already recorded');
});

test('invalid events never reach the recorder', async (t) => {
  for (const [name, patch] of [
    ['negative seconds', { gpuSeconds: -1 }],
    ['NaN seconds', { gpuSeconds: NaN }],
    ['infinite seconds', { gpuSeconds: Infinity }],
    ['empty job id', { jobId: '' }],
    ['empty user id', { userId: '' }],
  ] as const) {
    await t.test(name, async () => {
      const { r, seen } = fakeRecorder();
      assert.equal(await recordModalUsage({ ...base, ...patch }, r), false);
      assert.equal(seen.length, 0);
    });
  }
});

test('zero GPU seconds is a valid measurement and is recorded', async () => {
  const { r, seen } = fakeRecorder();
  assert.equal(await recordModalUsage({ ...base, gpuSeconds: 0 }, r), true);
  assert.equal(seen.length, 1);
});

test('a recorder that throws is swallowed: losing a measurement must not fail the user\'s job', async () => {
  const r: UsageRecorder = { record: async () => { throw new Error('database is down'); } };
  assert.equal(await recordModalUsage(base, r), false);
});

test('the Supabase recorder calls the idempotent database function with the right parameters', async () => {
  let call: { fn: string; args: Record<string, unknown> } | null = null;
  const client = { rpc: async (fn: string, args: Record<string, unknown>) => { call = { fn, args }; return { data: true, error: null }; } };
  const rec = createSupabaseUsageRecorder(client as never);
  assert.equal(await rec.record(base), true);
  assert.deepEqual(call, {
    fn: 'record_modal_usage',
    args: { p_deployment_id: 'dep-1', p_user_id: 'user-a', p_service: 'convert', p_job_id: 'job-1', p_gpu_seconds: 12.34567 },
  });
  const dup = createSupabaseUsageRecorder({ rpc: async () => ({ data: false, error: null }) } as never);
  assert.equal(await dup.record(base), false);
  const bad = createSupabaseUsageRecorder({ rpc: async () => ({ data: null, error: { message: 'boom' } }) } as never);
  await assert.rejects(() => bad.record(base), /record_modal_usage: boom/);
});
