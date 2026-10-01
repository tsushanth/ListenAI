// npm test (node:test via tsx). The music job worker against per-user Modal deployments (same shape as the
// sound-effects worker tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/modalDeploymentsTestEnv.js'; // must precede the imports below: sets env before config loads
import { makeHarness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests } from '../lib/modalDeployments.js';
import { setUsageRecorderForTests, type UsageEventInput } from '../lib/modalUsage.js';
import { callModalWorker, processOneJob, DeploymentRequiredError, type MusicWorkerDeps } from './musicJobWorker.js';

const job = (over: Record<string, unknown> = {}) =>
  ({ id: 'job-1', user_id: 'user-a', prompt: 'ambient loop', duration_sec: 30, cache_key: 'k', status: 'processing', ...over }) as never;

async function withFetch<T>(handler: (url: string, init: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
const quickFetch = () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

test('the Modal call goes to the job owner\'s deployment with that deployment\'s own secret, and reports GPU seconds', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'music', 'https://a.modal.run', 'secret-for-a');
  h.store.seedReady('user-b', 'music', 'https://b.modal.run', 'secret-for-b');
  const seen: Array<{ url: string; auth: string | null }> = [];
  const result = await withFetch(
    (url, init) => { seen.push({ url, auth: (init.headers as Record<string, string>).Authorization }); return new Response(new Uint8Array([7]), { status: 200, headers: { 'X-GPU-Seconds': '9.5' } }); },
    () => callModalWorker(job({ user_id: 'user-b' })),
  );
  assert.deepEqual(seen, [{ url: 'https://b.modal.run/generate', auth: 'Bearer secret-for-b' }]);
  assert.equal(result.gpuSeconds, 9.5);
  assert.match(result.deploymentId, /^dep-/);
  setDeploymentManagerForTests(null);
});

test('no deployment for the job\'s owner -> DeploymentRequiredError and Modal is never called', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  let called = false;
  await withFetch(() => { called = true; return new Response('', { status: 200 }); }, async () => {
    await assert.rejects(() => callModalWorker(job()), DeploymentRequiredError);
  });
  assert.equal(called, false);
  setDeploymentManagerForTests(null);
});

test('a missing GPU-seconds header is unknown, not zero', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'music', 'https://a.modal.run', 'secret-for-a');
  const r = await withFetch(() => new Response(new Uint8Array([1]), { status: 200 }), () => callModalWorker(job()));
  assert.equal(r.gpuSeconds, null);
  setDeploymentManagerForTests(null);
});

function deps(over: Partial<MusicWorkerDeps> & { updates?: Array<[string, string, Record<string, unknown>]> } = {}): MusicWorkerDeps {
  const updates = over.updates ?? [];
  return {
    claimJob: async () => job(),
    updateStatus: (async (id: string, status: string, extra: Record<string, unknown>) => { updates.push([id, status, extra]); }) as never,
    uploadAudio: (async () => undefined) as never,
    callModalWorker: async () => ({ audio: Buffer.from([1]), gpuSeconds: 2.5, deploymentId: 'dep-9' }),
    ...over,
  };
}

test('a deployment that is gone fails the job with DEPLOYMENT_REQUIRED, not GENERATION_FAILED', async () => {
  const updates: Array<[string, string, Record<string, unknown>]> = [];
  await processOneJob(deps({ updates, callModalWorker: async () => { throw new DeploymentRequiredError(); } }));
  assert.equal(updates.at(-1)?.[2].errorCode, 'DEPLOYMENT_REQUIRED');
  const other: Array<[string, string, Record<string, unknown>]> = [];
  await processOneJob(deps({ updates: other, callModalWorker: async () => { throw new Error('worker 500'); } }));
  assert.equal(other.at(-1)?.[2].errorCode, 'GENERATION_FAILED');
});

test('a successful job records the measured GPU seconds against its deployment', async () => {
  const events: UsageEventInput[] = [];
  setUsageRecorderForTests({ record: async (ev) => { events.push(ev); return true; } });
  await withFetch(quickFetch, () => processOneJob(deps()));
  assert.deepEqual(events, [{ deploymentId: 'dep-9', userId: 'user-a', service: 'music', jobId: 'job-1', gpuSeconds: 2.5 }]);
  setUsageRecorderForTests(null);
});
