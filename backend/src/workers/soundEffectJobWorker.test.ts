// npm test (node:test via tsx). The sound-effect job worker against per-user Modal deployments.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/modalDeploymentsTestEnv.js'; // must precede the imports below: sets env before config loads
import { makeHarness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests } from '../lib/modalDeployments.js';
import { callModalWorker, processOneJob, DeploymentRequiredError, type SoundEffectWorkerDeps } from './soundEffectJobWorker.js';

const MIN = 60_000;
const job = (over: Record<string, unknown> = {}) =>
  ({ id: 'job-1', user_id: 'user-a', prompt: 'glass shattering', duration_sec: 3, cache_key: 'k', status: 'processing', ...over }) as never;

async function withFetch<T>(handler: (url: string, init: RequestInit) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('the Modal call goes to the job owner\'s deployment with that deployment\'s own secret', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'sound_effect', 'https://a.modal.run', 'secret-for-a');
  h.store.seedReady('user-b', 'sound_effect', 'https://b.modal.run', 'secret-for-b');

  const seen: Array<{ url: string; auth: string | null; body: string }> = [];
  const result = await withFetch(
    (url, init) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: String(init.body) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'X-GPU-Seconds': '4.25' } });
    },
    () => callModalWorker(job({ user_id: 'user-b' })),
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://b.modal.run/generate', 'never user-a\'s app');
  assert.equal(seen[0].auth, 'Bearer secret-for-b');
  assert.deepEqual(JSON.parse(seen[0].body), { prompt: 'glass shattering', duration_sec: 3 });
  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.equal(result.gpuSeconds, 4.25);
  setDeploymentManagerForTests(null);
});

test('no deployment for the job\'s owner -> DeploymentRequiredError, and Modal is never called', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('someone-else', 'sound_effect', 'https://x.modal.run', 'secret-x');
  let called = false;
  await withFetch(
    () => { called = true; return new Response('', { status: 200 }); },
    async () => {
      await assert.rejects(() => callModalWorker(job({ user_id: 'user-a' })), DeploymentRequiredError);
    },
  );
  assert.equal(called, false);
  setDeploymentManagerForTests(null);
});

test('a deployment that went idle while the job waited is treated as gone', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'sound_effect', 'https://a.modal.run', 'secret-for-a');
  h.clock.advance(31 * MIN);
  await withFetch(() => new Response('', { status: 200 }), async () => {
    await assert.rejects(() => callModalWorker(job()), DeploymentRequiredError);
  });
  setDeploymentManagerForTests(null);
});

test('a worker error response is a generation failure, not a missing deployment', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'sound_effect', 'https://a.modal.run', 'secret-for-a');
  await withFetch(() => new Response('boom', { status: 500 }), async () => {
    await assert.rejects(
      () => callModalWorker(job()),
      (err: Error) => !(err instanceof DeploymentRequiredError) && /returned 500/.test(err.message),
    );
  });
  setDeploymentManagerForTests(null);
});

test('a missing or garbage GPU-seconds header is reported as unknown, never NaN or negative', async () => {
  const h = makeHarness();
  setDeploymentManagerForTests(h.manager);
  h.store.seedReady('user-a', 'sound_effect', 'https://a.modal.run', 'secret-for-a');
  for (const header of [undefined, 'abc', '-3']) {
    const r = await withFetch(
      () => new Response(new Uint8Array([9]), { status: 200, headers: header === undefined ? {} : { 'X-GPU-Seconds': header } }),
      () => callModalWorker(job()),
    );
    assert.equal(r.gpuSeconds, null, `header ${header}`);
  }
  setDeploymentManagerForTests(null);
});

// ---------------------------------------------------------------------------------------------
// processOneJob: how each outcome is recorded
// ---------------------------------------------------------------------------------------------

function deps(over: Partial<SoundEffectWorkerDeps> & { updates?: Array<[string, string, Record<string, unknown>]> } = {}): SoundEffectWorkerDeps {
  const updates = over.updates ?? [];
  return {
    claimJob: async () => job(),
    updateStatus: (async (id: string, status: string, extra: Record<string, unknown>) => { updates.push([id, status, extra]); }) as never,
    uploadAudio: (async () => undefined) as never,
    callModalWorker: async () => ({ audio: Buffer.from([1]), gpuSeconds: 1.5 }),
    ...over,
  };
}

test('success marks the job ready', async () => {
  const updates: Array<[string, string, Record<string, unknown>]> = [];
  // The post-success billing report talks to Supabase/Stripe; answer instantly so the test does not wait on a network.
  const did = await withFetch(() => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }), () => processOneJob(deps({ updates })));
  assert.equal(did, true);
  assert.equal(updates.at(-1)?.[1], 'ready');
});

test('no deployment fails the job with DEPLOYMENT_REQUIRED, not GENERATION_FAILED', async () => {
  const updates: Array<[string, string, Record<string, unknown>]> = [];
  await processOneJob(deps({ updates, callModalWorker: async () => { throw new DeploymentRequiredError(); } }));
  const [, status, extra] = updates.at(-1)!;
  assert.equal(status, 'failed');
  assert.equal(extra.errorCode, 'DEPLOYMENT_REQUIRED');
});

test('any other error fails the job with GENERATION_FAILED', async () => {
  const updates: Array<[string, string, Record<string, unknown>]> = [];
  await processOneJob(deps({ updates, callModalWorker: async () => { throw new Error('Modal worker returned 500: boom'); } }));
  assert.equal(updates.at(-1)?.[2].errorCode, 'GENERATION_FAILED');
});

test('with no queued job there is nothing to do', async () => {
  assert.equal(await processOneJob(deps({ claimJob: async () => null })), false);
});
