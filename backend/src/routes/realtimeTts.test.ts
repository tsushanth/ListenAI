// npm test (node:test via tsx), matching voiceStudioRouter.test.ts / voiceStudioApiKey.test.ts's
// pattern: boot a real express server with app.listen(0) and hit it over the network with fetch,
// rather than vitest+supertest (not dependencies of this package).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRealtimeTtsRouter } from './realtimeTts.js';
import { TtsQuota, type QuotaOptions } from '../lib/ttsQuota.js';

const REAL_FETCH = global.fetch;

function stubFetch(impl: typeof fetch) {
  (global as unknown as { fetch: typeof fetch }).fetch = impl;
}

function restoreFetch() {
  (global as unknown as { fetch: typeof fetch }).fetch = REAL_FETCH;
}

// Each boot gets a fresh quota so tests do not share counters.
async function boot(opts: QuotaOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/realtime-tts', createRealtimeTtsRouter(new TtsQuota({ log: () => {}, ...opts })));
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


test('POST /authorize with alignment:true forwards it and returns alignment:true plus the worker url the gateway gave', async () => {
  process.env.REALTIME_TTS_API_KEY = 'test-dedicated-key';
  const calls: { options: RequestInit }[] = [];
  stubFetch((async (_url: string, options: RequestInit) => {
    calls.push({ options });
    return { ok: true, status: 200, json: async () => ({ token: 't', url: 'wss://piper-align-sjc.fly.dev/tts', alignment: true }), text: async () => '' } as Response;
  }) as typeof fetch);
  const { base, close } = await boot();
  try {
    const res = await REAL_FETCH(`${base}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'piper', alignment: true }) });
    assert.deepEqual(await res.json(), { token: 't', url: 'wss://piper-align-sjc.fly.dev/tts', alignment: true });
    assert.equal(JSON.parse(calls[0].options.body as string).alignment, true);
  } finally { close(); restoreFetch(); }
});

test('POST /authorize with alignment:true against a gateway that does not support it returns alignment:false', async () => {
  process.env.REALTIME_TTS_API_KEY = 'test-dedicated-key';
  stubFetch((async () => ({ ok: true, status: 200, json: async () => ({ token: 't', url: 'wss://piper-tts-sjc.fly.dev/tts' }), text: async () => '' } as Response)) as typeof fetch);
  const { base, close } = await boot();
  try {
    const res = await REAL_FETCH(`${base}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alignment: true }) });
    assert.deepEqual(await res.json(), { token: 't', url: 'wss://piper-tts-sjc.fly.dev/tts', alignment: false });
  } finally { close(); restoreFetch(); }
});

test('POST /authorize: alignment is only forwarded for a literal true and is absent from the answer otherwise', async () => {
  process.env.REALTIME_TTS_API_KEY = 'test-dedicated-key';
  const bodies: string[] = [];
  stubFetch((async (_u: string, o: RequestInit) => { bodies.push(o.body as string); return { ok: true, status: 200, json: async () => ({ token: 't', url: 'u' }), text: async () => '' } as Response; }) as typeof fetch);
  const { base, close } = await boot();
  try {
    for (const v of ['true', 1, 'yes', undefined]) {
      const res = await REAL_FETCH(`${base}/authorize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alignment: v }) });
      assert.deepEqual(await res.json(), { token: 't', url: 'u' });
    }
    assert.ok(bodies.every((b) => !('alignment' in JSON.parse(b))));
  } finally { close(); restoreFetch(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Per-install quota, per-minute limit, global breaker (lib/ttsQuota.ts). Same stubbed-gateway pattern as above.
// ---------------------------------------------------------------------------------------------------------------
const ID_A = '0b6f2c7e-4a51-4d0e-9a3b-6f1d2c3e4a5b';
const ID_B = '9c1d7a22-1f0e-4b7c-8d55-aa10b2c3d4e5';

function okGateway(calls?: { n: number }) {
  stubFetch((async () => {
    if (calls) calls.n++;
    return { ok: true, status: 200, json: async () => ({ token: 't', url: 'u' }), text: async () => '' } as Response;
  }) as typeof fetch);
}

function authorize(base: string, headers: Record<string, string> = {}) {
  return REAL_FETCH(`${base}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ engine: 'piper' }),
  });
}

test('quota: request with no X-Install-Id still works (anonymous IP bucket)', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  okGateway();
  const { base, close } = await boot({ env: {} });
  try {
    const res = await authorize(base);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { token: 't', url: 'u' });
  } finally { close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});

test('quota: a malformed X-Install-Id is treated as anonymous, not rejected', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  okGateway();
  // anonymous per-minute = 1, so a second request proves the bad header landed in the anonymous bucket
  const { base, close } = await boot({ env: { TTS_ANON_AUTHORIZE_PER_MIN: '1' } });
  try {
    assert.equal((await authorize(base, { 'x-install-id': 'not-a-uuid' })).status, 200);
    // a valid id from the same IP is a separate (identified) bucket
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200);
    assert.equal((await authorize(base, { 'x-install-id': '12345' })).status, 429);
  } finally { close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});

test('quota: per-minute limit returns 429 with Retry-After, per install id', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  okGateway();
  const { base, close } = await boot({ env: { TTS_USER_AUTHORIZE_PER_MIN: '2' } });
  try {
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200);
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200);
    const limited = await authorize(base, { 'x-install-id': ID_A });
    assert.equal(limited.status, 429);
    const ra = Number(limited.headers.get('retry-after'));
    assert.ok(ra >= 1 && ra <= 60, `Retry-After ${ra}`);
    assert.equal((await limited.json()).error, 'RATE_LIMITED');
    // another install is unaffected
    assert.equal((await authorize(base, { 'x-install-id': ID_B })).status, 200);
  } finally { close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});

test('quota: exhausted daily budget returns 402 with a short JSON error and no gateway call', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  const calls = { n: 0 };
  okGateway(calls);
  const { base, close } = await boot({ env: { TTS_USER_DAILY_CHARS: '8000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000' } });
  try {
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200);
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200);
    const res = await authorize(base, { 'x-install-id': ID_A });
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('retry-after'), null);
    assert.equal((await res.json()).error, 'QUOTA_EXCEEDED');
    assert.equal(calls.n, 2);
  } finally { close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});

test('quota: global breaker answers 503 with Retry-After once exceeded, and 0 is a kill switch', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  const calls = { n: 0 };
  okGateway(calls);
  const small = await boot({ env: { TTS_GLOBAL_DAILY_CHARS: '4000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000' } });
  const kill = await boot({ env: { TTS_GLOBAL_DAILY_CHARS: '0' } });
  try {
    assert.equal((await authorize(small.base, { 'x-install-id': ID_A })).status, 200);
    const tripped = await authorize(small.base, { 'x-install-id': ID_B }); // a different install: it is the GLOBAL limit
    assert.equal(tripped.status, 503);
    assert.ok(Number(tripped.headers.get('retry-after')) >= 1);
    assert.equal((await tripped.json()).error, 'TTS_UNAVAILABLE');

    const k = await authorize(kill.base, { 'x-install-id': ID_A });
    assert.equal(k.status, 503);
    assert.equal(calls.n, 1);
  } finally { small.close(); kill.close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});

test('quota: a failed gateway authorize refunds the reservation', async () => {
  process.env.REALTIME_TTS_API_KEY = 'k';
  let fail = true;
  stubFetch((async () => (fail
    ? ({ ok: false, status: 500, text: async () => 'x', json: async () => ({}) } as Response)
    : ({ ok: true, status: 200, json: async () => ({ token: 't', url: 'u' }), text: async () => '' } as Response))) as typeof fetch);
  const { base, close } = await boot({ env: { TTS_USER_DAILY_CHARS: '4000', TTS_AUTHORIZE_CHARS_ESTIMATE: '4000' } });
  try {
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 502);
    fail = false;
    assert.equal((await authorize(base, { 'x-install-id': ID_A })).status, 200); // budget was given back
  } finally { close(); restoreFetch(); delete process.env.REALTIME_TTS_API_KEY; }
});
