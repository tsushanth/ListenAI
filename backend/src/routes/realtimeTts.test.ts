// npm test (node:test via tsx), matching voiceStudioRouter.test.ts / voiceStudioApiKey.test.ts's
// pattern: boot a real express server with app.listen(0) and hit it over the network with fetch,
// rather than vitest+supertest (not dependencies of this package).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { realtimeTtsRouter } from './realtimeTts.js';

const REAL_FETCH = global.fetch;

function stubFetch(impl: typeof fetch) {
  (global as unknown as { fetch: typeof fetch }).fetch = impl;
}

function restoreFetch() {
  (global as unknown as { fetch: typeof fetch }).fetch = REAL_FETCH;
}

async function boot() {
  const app = express();
  app.use(express.json());
  app.use('/api/realtime-tts', realtimeTtsRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/realtime-tts`;
  return { base, close: () => server.close() };
}

test('POST /authorize forwards to the gateway and returns the token/url, never the raw key', async () => {
  process.env.REALTIME_TTS_API_KEY = 'test-dedicated-key';
  const calls: { url: string; options: RequestInit }[] = [];
  stubFetch((async (url: string, options: RequestInit) => {
    calls.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'session-token-abc', url: 'wss://piper-tts-sjc.fly.dev/tts' }),
      text: async () => '',
    } as Response;
  }) as typeof fetch);

  const { base, close } = await boot();
  try {
    // Use the saved real fetch for the test's own client request — global.fetch is stubbed above for the
    // route's own outbound call to the gateway, and both share the same global identifier.
    const res = await REAL_FETCH(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'piper' }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { token: 'session-token-abc', url: 'wss://piper-tts-sjc.fly.dev/tts' });
    // The response the client actually receives must never contain the raw platform key.
    assert.ok(!JSON.stringify(body).includes('test-dedicated-key'));

    assert.equal(calls.length, 1);
    const sentBody = JSON.parse(calls[0].options.body as string);
    assert.equal(sentBody.key, 'test-dedicated-key');
    assert.equal(sentBody.engine, 'piper');
  } finally {
    close();
    restoreFetch();
    delete process.env.REALTIME_TTS_API_KEY;
  }
});

test('POST /authorize returns 502 (and never leaks the key) when the gateway call fails', async () => {
  process.env.REALTIME_TTS_API_KEY = 'test-dedicated-key';
  stubFetch((async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"invalid or missing API key"}',
    json: async () => ({}),
  } as Response)) as typeof fetch);

  const { base, close } = await boot();
  try {
    const res = await REAL_FETCH(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'piper' }),
    });
    const body = await res.text();

    assert.equal(res.status, 502);
    assert.ok(!body.includes('test-dedicated-key'));
  } finally {
    close();
    restoreFetch();
    delete process.env.REALTIME_TTS_API_KEY;
  }
});

test('POST /authorize returns 500 and never calls the gateway when the key is not configured', async () => {
  delete process.env.REALTIME_TTS_API_KEY;
  let fetchCalled = false;
  stubFetch((async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch);

  const { base, close } = await boot();
  try {
    const res = await REAL_FETCH(`${base}/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'piper' }),
    });
    const body = await res.text();

    assert.equal(res.status, 500);
    assert.equal(fetchCalled, false);
    assert.ok(!body.includes('test-dedicated-key'));
  } finally {
    close();
    restoreFetch();
  }
});
