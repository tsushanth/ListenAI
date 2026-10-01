// npm test (node:test via tsx). Unit tests for text-to-music routes.
// Supabase RPC calls are intercepted via a patched global.fetch, matching the
// pattern used in voiceDesign.test.ts. Auth is stubbed directly (req.userId)
// rather than going through requireRealAuth, since that middleware is tested
// separately (ttsApiKeys.ts) and this file's job is the route logic itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import '../lib/modalDeploymentsTestEnv.js'; // sets env before config loads (must precede the imports below)
import { makeHarness, type Harness } from '../lib/modalDeploymentsTestKit.js';
import { setDeploymentManagerForTests } from '../lib/modalDeployments.js';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
// The route fails closed unless the worker is enabled AND the metered price is
// configured (see isMusicProvisioned); existing tests assume a provisioned env.
process.env.MUSIC_WORKER_ENABLED = 'true';
process.env.MUSIC_GENERATION_PRICE_ID ??= 'price_test_music';

// ---------------------------------------------------------------------------
// Intercept fetch for Supabase RPC calls backing the music_jobs table.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

interface FakeJob {
  id: string;
  user_id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  prompt: string;
  duration_sec: number;
  cache_key: string;
  audio_path: string | null;
  error_code: string | null;
  error_message: string | null;
}

const jobsById = new Map<string, FakeJob>();
const jobsByCacheKey = new Map<string, FakeJob>();
let jobCounter = 0;

// Controls the billing gate (isBillingActiveForUser -> getBillingForUser),
// which queries the `realtimetts_billing` table via plain PostgREST (not an
// RPC) — mirrors the pattern in voiceDesign.test.ts. Defaults to active so
// existing tests above (written before the billing gate existed) keep
// passing without every one of them needing to know about billing.
let billingActive = true;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.startsWith('http://localhost:54321/rest/v1/realtimetts_billing')) {
    const u = new URL(url);
    const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '');
    if (billingActive && uid) {
      return new Response(JSON.stringify([{
        user_id: uid,
        stripe_customer_id: `cus_${uid}`,
        stripe_subscription_id: 'sub_test',
        stripe_subscription_item_id: 'si_test',
        active: true,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url.startsWith('http://localhost:54321/rest/v1/rpc/')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const fn = url.replace('http://localhost:54321/rest/v1/rpc/', '');

    if (fn === 'create_music_job') {
      const id = `job-${(++jobCounter).toString().padStart(4, '0')}`;
      const job: FakeJob = {
        id,
        user_id: body.p_user_id,
        status: 'queued',
        prompt: body.p_prompt,
        duration_sec: body.p_duration_sec,
        cache_key: body.p_cache_key,
        audio_path: null,
        error_code: null,
        error_message: null,
      };
      jobsById.set(id, job);
      jobsByCacheKey.set(job.cache_key, job);
      return new Response(JSON.stringify(id), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (fn === 'get_music_job_for_user') {
      const job = jobsById.get(body.p_job_id);
      const visible = job && job.user_id === body.p_user_id ? job : null;
      return new Response(JSON.stringify(visible), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (fn === 'get_cached_music') {
      const job = jobsByCacheKey.get(body.p_cache_key) ?? null;
      // Only cache-hit if it's actually ready with audio, otherwise treat as miss.
      const visible = job && job.status === 'ready' && job.audio_path ? job : null;
      return new Response(JSON.stringify(visible), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

function buildTestApp(userId: string) {
  return async () => {
    const { textToMusicRouter } = await import('./textToMusic.js');
    const { errorHandler } = await import('../middleware/errorHandler.js');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.userId = userId; next(); });
    app.use('/api/music', textToMusicRouter);
    app.use(errorHandler);
    return app;
  };
}

// Generation runs on the caller's own Modal deployment, so by default each booted user has a ready one.
let harness: Harness = makeHarness();
function useHarness(seedFor?: string): Harness {
  harness = makeHarness();
  setDeploymentManagerForTests(harness.manager);
  if (seedFor) harness.store.seedReady(seedFor, 'music', 'https://music-user.modal.run', 'music-secret-value');
  return harness;
}

async function boot(userId = '00000000-0000-0000-0000-000000000001', opts: { deployed?: boolean } = {}) {
  useHarness(opts.deployed === false ? undefined : userId);
  const buildApp = buildTestApp(userId);
  const app = await buildApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/music`;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  return { call, server, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('POST /job rejects a missing prompt with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { duration_sec: 30 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job rejects duration_sec outside the allowed range with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'ambient loop', duration_sec: 600 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job creates a job and returns 202 processing on cache miss', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'unique-test-prompt-xyz', duration_sec: 30 });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'processing');
  assert.ok(body.job_id);
  s.close();
});

test('POST /job returns 402 and does not create a job when billing is not active', async () => {
  billingActive = false;
  try {
    const s = await boot();
    const jobsBefore = jobCounter;
    const res = await s.call('POST', '/job', { prompt: 'no-billing-prompt-should-not-create-job', duration_sec: 30 });
    assert.equal(res.status, 402);
    assert.equal(jobCounter, jobsBefore, 'no job should have been created');
    s.close();
  } finally {
    billingActive = true;
  }
});

test('GET /job/:jobId returns 404 for a job belonging to a different user', async () => {
  const creator = await boot('00000000-0000-0000-0000-000000000001');
  const createRes = await creator.call('POST', '/job', { prompt: 'owner-only-prompt', duration_sec: 30 });
  const { job_id } = await createRes.json();
  creator.close();

  const otherUser = await boot('00000000-0000-0000-0000-000000000002');
  const getRes = await otherUser.call('GET', `/job/${job_id}`);
  assert.equal(getRes.status, 404);
  otherUser.close();
});

test('GET /job/:jobId on a cache-* pseudo id returns 200 ready with no audio_url', async () => {
  const s = await boot();
  const getRes = await s.call('GET', '/job/cache-abcd1234');
  assert.equal(getRes.status, 200);
  const body = await getRes.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.audio_url, undefined);
  s.close();
});

test('GET /job/:jobId on a malformed, non-UUID, non-cache- id returns 404, not 500', async () => {
  const s = await boot();
  const getRes = await s.call('GET', '/job/not-a-real-id');
  assert.equal(getRes.status, 404);
  s.close();
});

test('POST /job returns 503 and creates no job when the metered price is not configured', async () => {
  const saved = process.env.MUSIC_GENERATION_PRICE_ID;
  delete process.env.MUSIC_GENERATION_PRICE_ID;
  try {
    const s = await boot();
    const jobsBefore = jobCounter;
    const res = await s.call('POST', '/job', { prompt: 'unpriced-should-not-create-job', duration_sec: 30 });
    assert.equal(res.status, 503);
    assert.equal(jobCounter, jobsBefore, 'no job should have been created');
    s.close();
  } finally {
    process.env.MUSIC_GENERATION_PRICE_ID = saved;
  }
});

test('POST /job returns 503 when the music worker is not enabled', async () => {
  const saved = process.env.MUSIC_WORKER_ENABLED;
  delete process.env.MUSIC_WORKER_ENABLED;
  try {
    const s = await boot();
    const jobsBefore = jobCounter;
    const res = await s.call('POST', '/job', { prompt: 'no-worker-should-not-create-job', duration_sec: 30 });
    assert.equal(res.status, 503);
    assert.equal(jobCounter, jobsBefore);
    s.close();
  } finally {
    process.env.MUSIC_WORKER_ENABLED = saved;
  }
});


// ---------------------------------------------------------------------------
// Self-serve deployment: generation runs on the caller's own Modal app
// ---------------------------------------------------------------------------

test('POST /job without a ready deployment -> 400 deployment_required, and no job is created', async () => {
  const s = await boot('00000000-0000-0000-0000-0000000000c1', { deployed: false });
  const before = jobCounter;
  const res = await s.call('POST', '/job', { prompt: 'music-needs-a-deployment-unique', duration_sec: 30 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'deployment_required');
  assert.match(body.error, /POST \/api\/music\/deploy/);
  assert.equal(jobCounter, before, 'nothing queued for a worker that does not exist');
  s.close();
});

test('POST /job counts the job on the deployment and restarts its idle clock', async () => {
  const uid = '00000000-0000-0000-0000-0000000000c2';
  const s = await boot(uid);
  harness.clock.advance(20 * 60_000);
  const res = await s.call('POST', '/job', { prompt: 'music-counts-the-job-unique', duration_sec: 20 });
  assert.equal(res.status, 202);
  const row = harness.store.liveFor(uid, 'music');
  assert.equal(row?.job_count, 1);
  assert.equal(row?.last_used_at, harness.clock.now().toISOString());
  s.close();
});

test('the deploy endpoints are mounted: deploy, status, teardown, and a job works once deployed', async () => {
  const uid = '00000000-0000-0000-0000-0000000000c3';
  const s = await boot(uid, { deployed: false });
  harness.paying.add(uid);

  assert.equal((await s.call('GET', '/deploy')).status, 404);
  const post = await s.call('POST', '/deploy');
  assert.equal(post.status, 202);
  assert.equal((await post.json()).service, 'music');
  await harness.manager.whenIdle();
  assert.equal((await (await s.call('GET', '/deploy')).json()).status, 'ready');

  const call = harness.cli.calls.find((c) => c.op === 'deploy');
  assert.equal(call?.args[0], 'modal/music_worker.py');
  const env = call?.args[1] as Record<string, string>;
  assert.match(env.MUSIC_APP_SUFFIX, /^-user-/);
  assert.match(env.MUSIC_SECRET_NAME, /^music-readaloud-user-/);

  assert.equal((await s.call('POST', '/job', { prompt: 'music-after-deploy-unique', duration_sec: 20 })).status, 202);
  assert.equal((await s.call('DELETE', '/deploy')).status, 200);
  assert.equal((await s.call('POST', '/job', { prompt: 'music-after-teardown-unique', duration_sec: 20 })).status, 400);
  s.close();
});

test('deploy is refused when music is not provisioned, so no GPU starts for a feature that cannot earn its cost', async () => {
  const uid = '00000000-0000-0000-0000-0000000000c4';
  const s = await boot(uid, { deployed: false });
  harness.paying.add(uid);
  const price = process.env.MUSIC_GENERATION_PRICE_ID;
  delete process.env.MUSIC_GENERATION_PRICE_ID; // not provisioned: no billing price configured
  try {
    const res = await s.call('POST', '/deploy');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'service_unavailable');
    assert.equal(harness.cli.calls.length, 0, 'Modal was never touched');
    assert.equal(harness.store.rows.size, 0);
  } finally {
    process.env.MUSIC_GENERATION_PRICE_ID = price;
    s.close();
  }
});
