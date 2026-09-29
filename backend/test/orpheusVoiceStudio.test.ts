// npm test (node:test via tsx). Unit tests for the web-session-authenticated Orpheus clone router
// (routes/orpheusVoiceStudio.ts).
//
// The Supabase identity check (lib/auth.ts's verifyAuthTokenRemote) calls Supabase over axios, which uses
// Node's real http stack rather than global.fetch, so — unlike the Modal calls below — it can't be
// intercepted by patching globalThis.fetch (and a real loopback HTTP server is not reachable from this
// sandboxed test environment either). Instead we mock the `lib/auth.js` module itself via node:test's
// `mock.module` (needs `--experimental-test-module-mocks`, wired into package.json's test script) so
// `verifyAuthTokenRemote`/`extractBearerToken` behave like a real Supabase check without any network call.
// The Modal training/serving calls are intercepted via a patched global.fetch (this router's own
// `fetch()` calls), so no real network calls happen there either.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

mock.module('../src/lib/auth.js', {
  namedExports: {
    extractBearerToken: (authHeader?: string) => {
      if (!authHeader) return '';
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') return '';
      return parts[1] ?? '';
    },
    verifyAuthTokenRemote: async (token: string) => {
      if (token === 'valid-token-user-42') return { userId: 'user-42' };
      throw new Error('Invalid or expired token');
    },
  },
});

// Billing: default every user to an active subscription so the pre-existing tests above (written before
// the billing gate existed) keep exercising the happy path unchanged. Tests that need inactive billing or
// a charge/usage-report failure flip `billingActive`/`chargeShouldFail`/`usageReportShouldFail` for the
// duration of that one test and reset them in `finally`.
export let billingActive = true;
export let chargeShouldFail = false;
export let usageReportShouldFail = false;
export const chargeCalls: string[] = [];
export const usageReportCalls: Array<{ userId: string; charCount: number }> = [];

mock.module('../src/lib/realtimeTtsBilling.js', {
  namedExports: {
    isBillingActiveForUser: async (_userId: string) => billingActive,
    chargeForVoiceClone: async (identity: string) => {
      chargeCalls.push(identity);
      if (chargeShouldFail) return { success: false, error: 'Stripe error' };
      return { success: true, invoiceItemId: 'ii_test' };
    },
    reportTtsUsage: async (userId: string, charCount: number) => {
      usageReportCalls.push({ userId, charCount });
      if (usageReportShouldFail) throw new Error('Stripe meter event failed');
    },
  },
});

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';
process.env.ORPHEUS_CLONE_SERVICE_URL = 'https://orpheus-clone.modal.run';
process.env.ORPHEUS_CLONE_SECRET = 'test-modal-secret';

const modalRequests: Array<{ method: string; url: string; authorization: string | null; owner: string | null; body: string }> = [];
let nextModalBinaryResponse: { body: Uint8Array; contentType: string } | null = null;

let originalFetch: typeof globalThis.fetch;

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (!url.startsWith('https://orpheus-clone.modal.run')) {
      return originalFetch(input, init);
    }
    const headers = (init?.headers as Record<string, string>) || {};
    const bodyText = typeof init?.body === 'string' ? init.body : init?.body ? Buffer.from(init.body as any).toString() : '';
    modalRequests.push({
      method: init?.method || 'GET',
      url,
      authorization: headers['authorization'] ?? null,
      owner: headers['x-owner'] ?? null,
      body: bodyText,
    });
    if (nextModalBinaryResponse) {
      const { body, contentType } = nextModalBinaryResponse;
      nextModalBinaryResponse = null;
      return new Response(body, { status: 200, headers: { 'Content-Type': contentType } });
    }
    return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
}

async function boot() {
  const { orpheusVoiceStudioRouter } = await import('../src/routes/orpheusVoiceStudio.js');
  const app = express();
  app.use('/api/orpheus-voice-studio', orpheusVoiceStudioRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orpheus-voice-studio`;

  const call = (headers: Record<string, string>, method: string, path: string, body?: object) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  return { call, close: () => { server.close(); } };
}

const AUTH = { authorization: 'Bearer valid-token-user-42' };

test('no Authorization header -> 401, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({}, 'POST', '/', { speaker_name: 'Test' });
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('invalid bearer token -> 401, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({ authorization: 'Bearer garbage' }, 'GET', '/v-deadbeef00');
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('valid session -> POST / forwarded to Modal with bearer token and Supabase user id as owner', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/', { speaker_name: 'Test Speaker' });
    assert.equal(res.status, 200);
    assert.equal(modalRequests.length, 1);
    assert.equal(modalRequests[0].method, 'POST');
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-voices');
    assert.equal(modalRequests[0].authorization, 'Bearer test-modal-secret');
    assert.equal(modalRequests[0].owner, 'user-42');
    assert.equal(JSON.parse(modalRequests[0].body).speaker_name, 'Test Speaker');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('valid session -> GET /:vid forwarded to Modal detail path scoped to caller', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'GET', '/v-deadbeef00');
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-voices/v-deadbeef00');
    assert.equal(modalRequests[0].owner, 'user-42');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('valid session -> DELETE /:vid forwarded to Modal delete path', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'DELETE', '/v-deadbeef00');
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].method, 'DELETE');
    assert.equal(modalRequests[0].owner, 'user-42');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('unauthenticated POST /tts -> 401, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({}, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('valid session -> POST /tts forwarded to Modal synthesis endpoint', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-tts');
    assert.equal(modalRequests[0].owner, 'user-42');
    const sentBody = JSON.parse(modalRequests[0].body);
    assert.equal(sentBody.voice, 'v-deadbeef00');
    assert.equal(sentBody.text, 'hello world');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('POST /tts relays binary PCM audio byte-for-byte, not corrupted by UTF-8 text decoding', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const pcmBytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
  nextModalBinaryResponse = { body: pcmBytes, contentType: 'audio/pcm' };
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/pcm');
    const receivedBuf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(receivedBuf, Buffer.from(pcmBytes), 'relayed body must be byte-for-byte identical to the Modal response');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('malformed vid with path traversal -> 400, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'GET', '/..%2F..%2Fadmin');
    assert.equal(res.status, 400);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('malformed vid with injected query string -> 400, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'DELETE', '/v-1%3Fx%3D1');
    assert.equal(res.status, 400);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('malformed vid on POST /:vid/dataset/commit -> 400, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/..%2F..%2Fadmin/dataset/commit');
    assert.equal(res.status, 400);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('unauthenticated PUT /:vid/dataset -> 401, Modal never called (auth before body parse)', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({}, 'PUT', '/v-test123/dataset', { test: 'data' });
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0, 'Modal should not be called for unauthenticated requests');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('billing inactive -> POST / returns 402, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  billingActive = false;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/', { speaker_name: 'Test' });
    assert.equal(res.status, 402);
    assert.deepEqual(await res.json(), { error: 'Voice cloning requires an active TTS subscription.' });
    assert.equal(modalRequests.length, 0);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('billing inactive -> PUT /:vid/dataset returns 402, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  billingActive = false;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'PUT', '/v-deadbeef00/dataset', { some: 'zip' });
    assert.equal(res.status, 402);
    assert.equal(modalRequests.length, 0);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('billing inactive -> POST /:vid/dataset/commit returns 402, Modal never called, no charge', async () => {
  installFetchMock();
  modalRequests.length = 0;
  chargeCalls.length = 0;
  billingActive = false;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/v-deadbeef00/dataset/commit', {});
    assert.equal(res.status, 402);
    assert.equal(modalRequests.length, 0);
    assert.equal(chargeCalls.length, 0);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('billing inactive -> POST /tts returns 402, Modal never called, no usage report', async () => {
  installFetchMock();
  modalRequests.length = 0;
  usageReportCalls.length = 0;
  billingActive = false;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 402);
    assert.equal(modalRequests.length, 0);
    assert.equal(usageReportCalls.length, 0);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('billing active -> GET /:vid still works (status endpoint is never gated)', async () => {
  installFetchMock();
  modalRequests.length = 0;
  billingActive = false; // inactive billing must not block status
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'GET', '/v-deadbeef00');
    assert.equal(res.status, 200);
    assert.equal(modalRequests.length, 1);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('billing inactive -> DELETE /:vid still works (delete endpoint is never gated)', async () => {
  installFetchMock();
  modalRequests.length = 0;
  billingActive = false; // inactive billing must not block delete
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'DELETE', '/v-deadbeef00');
    assert.equal(res.status, 200);
    assert.equal(modalRequests.length, 1);
  } finally {
    billingActive = true;
    close();
    uninstallFetchMock();
  }
});

test('successful dataset commit charges $2.50 via chargeForVoiceClone for the session owner', async () => {
  installFetchMock();
  modalRequests.length = 0;
  chargeCalls.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/v-deadbeef00/dataset/commit', {});
    assert.equal(res.status, 200);
    assert.equal(modalRequests.length, 1);
    // chargeForVoiceClone is fire-and-forget after the response; give its .catch() a tick.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(chargeCalls, ['user-42']);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('charge failure does not block or fail the dataset commit response', async () => {
  installFetchMock();
  modalRequests.length = 0;
  chargeCalls.length = 0;
  chargeShouldFail = true;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/v-deadbeef00/dataset/commit', {});
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(chargeCalls, ['user-42']);
  } finally {
    chargeShouldFail = false;
    close();
    uninstallFetchMock();
  }
});

test('successful synthesis reports usage via reportTtsUsage with the synthesized character count', async () => {
  installFetchMock();
  modalRequests.length = 0;
  usageReportCalls.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(usageReportCalls, [{ userId: 'user-42', charCount: 'hello world'.length }]);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('usage-report failure does not block or fail the synthesis response', async () => {
  installFetchMock();
  modalRequests.length = 0;
  usageReportCalls.length = 0;
  usageReportShouldFail = true;
  const { call, close } = await boot();
  try {
    const res = await call(AUTH, 'POST', '/tts', { voice: 'v-deadbeef00', text: 'hello world' });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(usageReportCalls.length, 1);
  } finally {
    usageReportShouldFail = false;
    close();
    uninstallFetchMock();
  }
});

test('one user cannot use another user id as owner: owner is always derived from the verified session', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    // Even if the client tries to smuggle an owner/user id in the body, the route ignores it and always
    // forwards the Supabase-verified user id as X-Owner.
    const res = await call(AUTH, 'POST', '/', { speaker_name: 'Test', owner: 'someone-elses-id', x_owner: 'someone-elses-id' });
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].owner, 'user-42');
  } finally {
    close();
    uninstallFetchMock();
  }
});
