// npm test (node:test via tsx). Unit tests for text-to-music routes.
// Supabase RPC calls are intercepted via a patched global.fetch, matching the
// pattern used in voiceDesign.test.ts. Auth is stubbed directly (req.userId)
// rather than going through requireRealAuth, since that middleware is tested
// separately (ttsApiKeys.ts) and this file's job is the route logic itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

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

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

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

async function boot(userId = '00000000-0000-0000-0000-000000000001') {
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
