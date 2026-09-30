// npm test (node:test via tsx). Unit tests for sound-effects routes.
// Supabase RPC/storage calls are intercepted via a patched global.fetch, matching the
// pattern used in textToMusic.test.ts (this feature mirrors text-to-music 1:1 in shape).
// Auth for the route-logic tests below is stubbed directly (req.userId), same as
// textToMusic.test.ts, since requireAuthOrApiKey itself is already covered by its own
// dedicated suite (middleware/apiKeyAuth.test.ts). A separate block further down mounts
// the REAL requireAuthOrApiKey middleware in front of this router to prove the strict-auth
// fix actually took: no default-user fallback, unauthenticated/invalid requests are
// rejected outright, never silently billed to a shared user.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
// Set before any import in this process — config.ts reads env once at module load and
// caches it (see apiKeyAuth.test.ts's own comment on this), so this must be set up front
// rather than inside bootWithRealAuth() below, which runs after other imports in this
// file have already triggered config.ts's first load.
const FORWARD_SECRET = 'sfx-test-forward-secret';
process.env.GATEWAY_FORWARD_SECRET ??= FORWARD_SECRET;

// ---------------------------------------------------------------------------
// Intercept fetch for Supabase RPC + storage calls backing sound_effect_jobs.
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

// Controls the billing gate (isBillingActiveForUser -> getBillingForUser), which queries
// the `realtimetts_billing` table via plain PostgREST (not an RPC) — mirrors
// textToMusic.test.ts / voiceDesign.test.ts. Defaults to active.
let billingActive = true;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url.includes('/realtimetts_free_credits')) {
    // Free-credit gate (hasUsageAllowance): exhausted, so inactive-billing tests still 402 quickly.
    return new Response(JSON.stringify([{ granted: 10000, used: 10000 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
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

  // getSignedAudioUrl -> supabase.storage.from(...).createSignedUrl(...), which POSTs to
  // /storage/v1/object/sign/<bucket>/<path>.
  if (url.includes('/storage/v1/object/sign/')) {
    return new Response(JSON.stringify({ signedURL: '/signed/fake-audio.wav', signedUrl: 'https://example.test/signed/fake-audio.wav' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (url.startsWith('http://localhost:54321/rest/v1/rpc/')) {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const fn = url.replace('http://localhost:54321/rest/v1/rpc/', '');

    if (fn === 'create_sound_effect_job') {
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

    if (fn === 'get_sound_effect_job_for_user') {
      const job = jobsById.get(body.p_job_id);
      const visible = job && job.user_id === body.p_user_id ? job : null;
      return new Response(JSON.stringify(visible), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (fn === 'get_cached_sound_effect') {
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
// Boot helpers — route-logic tests (auth stubbed, mirrors textToMusic.test.ts)
// ---------------------------------------------------------------------------

function buildTestApp(userId: string) {
  return async () => {
    const { soundEffectsRouter } = await import('./soundEffects.js');
    const { errorHandler } = await import('../middleware/errorHandler.js');

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.userId = userId; next(); });
    app.use('/api/sound-effects', soundEffectsRouter);
    app.use(errorHandler);
    return app;
  };
}

async function boot(userId = '00000000-0000-0000-0000-000000000001') {
  const buildApp = buildTestApp(userId);
  const app = await buildApp();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sound-effects`;

  const call = (method: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });

  return { call, server, close: () => server.close() };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('POST /job rejects a missing prompt with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { duration_sec: 3 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job rejects an empty prompt with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: '', duration_sec: 3 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job rejects a prompt over 500 characters with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'x'.repeat(501), duration_sec: 3 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job rejects duration_sec below the 1s floor with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'glass shattering', duration_sec: 0 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job rejects duration_sec above the 12s ceiling with 400', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'glass shattering', duration_sec: 13 });
  assert.equal(res.status, 400);
  s.close();
});

test('POST /job accepts duration_sec at the 1s and 12s boundaries', async () => {
  const s = await boot();
  const low = await s.call('POST', '/job', { prompt: 'boundary-test-low-unique', duration_sec: 1 });
  assert.equal(low.status, 202);
  const high = await s.call('POST', '/job', { prompt: 'boundary-test-high-unique', duration_sec: 12 });
  assert.equal(high.status, 202);
  s.close();
});

// ---------------------------------------------------------------------------
// Billing / cache-hit-no-double-bill
// ---------------------------------------------------------------------------

test('POST /job creates a job and returns 202 processing on cache miss', async () => {
  const s = await boot();
  const res = await s.call('POST', '/job', { prompt: 'unique-sfx-prompt-xyz', duration_sec: 3 });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'processing');
  assert.equal(body.cache_hit, false);
  assert.ok(body.job_id);
  s.close();
});

test('POST /job returns 402 and does not create a job when billing is not active', async () => {
  billingActive = false;
  try {
    const s = await boot();
    const jobsBefore = jobCounter;
    const res = await s.call('POST', '/job', { prompt: 'no-billing-sfx-prompt-should-not-create-job', duration_sec: 3 });
    assert.equal(res.status, 402);
    assert.equal(jobCounter, jobsBefore, 'no job should have been created');
    s.close();
  } finally {
    billingActive = true;
  }
});

test('POST /job on a cache hit returns 202 ready with audio_url and does NOT call the billing gate', async () => {
  // Prime the cache: create+complete a job under one user, then hit the same
  // prompt/duration from a DIFFERENT user while billing is inactive. If the
  // route billed before checking cache (or checked cache after billing), this
  // would 402 instead of serving the cached result.
  const creatorId = '00000000-0000-0000-0000-0000000000c1';
  const creator = await boot(creatorId);
  const createRes = await creator.call('POST', '/job', { prompt: 'cache-hit-sfx-prompt', duration_sec: 5 });
  const { job_id } = await createRes.json();
  creator.close();

  const job = jobsById.get(job_id)!;
  job.status = 'ready';
  job.audio_path = 'sound-effects/cache-hit-sfx-prompt.wav';
  jobsByCacheKey.set(job.cache_key, job);

  billingActive = false;
  try {
    const otherUserId = '00000000-0000-0000-0000-0000000000c2';
    const other = await boot(otherUserId);
    const res = await other.call('POST', '/job', { prompt: 'cache-hit-sfx-prompt', duration_sec: 5 });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.cache_hit, true);
    assert.equal(body.status, 'ready');
    assert.ok(body.audio_url);
    // Synthetic pseudo id, not the original generating job's real id.
    assert.notEqual(body.job_id, job_id);
    assert.match(body.job_id, /^cache-/);
    other.close();
  } finally {
    billingActive = true;
  }
});

test('GET /job/:jobId returns 404 for a job belonging to a different user', async () => {
  const creator = await boot('00000000-0000-0000-0000-000000000001');
  const createRes = await creator.call('POST', '/job', { prompt: 'owner-only-sfx-prompt', duration_sec: 3 });
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

// ---------------------------------------------------------------------------
// Strict auth gate (requireAuthOrApiKey) — the regression this branch fixes.
//
// Mounts the REAL middleware (not a stubbed req.userId) in front of the real
// router, exactly as backend/src/index.ts does, to prove there is no
// default-user fallback: a request with no credentials, or garbage
// credentials, is rejected outright rather than silently resolved to a
// shared default user and billed against it.
// ---------------------------------------------------------------------------

async function bootWithRealAuth(): Promise<{ base: string; close: () => void }> {
  const [{ requireAuthOrApiKey }, { soundEffectsRouter: router }, { errorHandler }] = await Promise.all([
    import(`../middleware/apiKeyAuth.js?t=${Date.now()}-${Math.random()}`),
    import('./soundEffects.js'),
    import('../middleware/errorHandler.js'),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/sound-effects', requireAuthOrApiKey, router);
  app.use(errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/api/sound-effects`, close: () => server.close() };
}

test('POST /job with no credentials at all is rejected with 401, not billed to a default user', async () => {
  const s = await bootWithRealAuth();
  const jobsBefore = jobCounter;
  const res = await fetch(`${s.base}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'unauthenticated-should-not-bill', duration_sec: 3 }),
  });
  assert.equal(res.status, 401);
  assert.equal(jobCounter, jobsBefore, 'no job should have been created for an unauthenticated caller');
  s.close();
});

test('POST /job with a garbage bearer token (the old raw-API-key-forwarded-as-JWT bug) is rejected with 401', async () => {
  const s = await bootWithRealAuth();
  const jobsBefore = jobCounter;
  const res = await fetch(`${s.base}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_live_some_raw_gateway_api_key' },
    body: JSON.stringify({ prompt: 'garbage-bearer-should-not-bill', duration_sec: 3 }),
  });
  assert.equal(res.status, 401);
  assert.equal(jobCounter, jobsBefore, 'no job should have been created for an invalid bearer token');
  s.close();
});

test('POST /job with the wrong gateway-forward secret is rejected with 401, even with identity headers present', async () => {
  const s = await bootWithRealAuth();
  const res = await fetch(`${s.base}/job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-admin-secret': 'not-the-real-secret',
      'x-gateway-uid': '00000000-0000-0000-0000-000000000099',
    },
    body: JSON.stringify({ prompt: 'wrong-secret-should-not-bill', duration_sec: 3 }),
  });
  assert.equal(res.status, 401);
  s.close();
});

test('POST /job with a valid gateway-forwarded API key identity succeeds and bills that resolved user, not a shared default', async () => {
  const s = await bootWithRealAuth();
  const uid = '00000000-0000-0000-0000-0000000000aa';
  const res = await fetch(`${s.base}/job`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gateway-admin-secret': FORWARD_SECRET,
      'x-gateway-uid': uid,
    },
    body: JSON.stringify({ prompt: 'gateway-key-identity-unique-prompt', duration_sec: 3 }),
  });
  assert.equal(res.status, 202);
  const job = jobsById.get((await res.json()).job_id);
  assert.equal(job?.user_id, uid);
  s.close();
});
