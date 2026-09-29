// npm test (node:test via tsx). Unit tests for the internal, gateway-trusted Orpheus clone router
// (routes/orpheusVoiceStudioApiKey.ts). Mocks global.fetch so no real Modal calls happen — this only
// exercises the shared-secret gate and forwarding to the right Modal path with the right bearer token.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.GATEWAY_FORWARD_SECRET = 'test-forward-secret';
process.env.ORPHEUS_CLONE_SERVICE_URL = 'https://orpheus-clone.modal.run';
process.env.ORPHEUS_CLONE_SECRET = 'test-modal-secret';
process.env.NODE_ENV = 'test';

const modalRequests: Array<{ method: string; url: string; authorization: string | null; body: string }> = [];

let originalFetch: typeof globalThis.fetch;

function installFetchMock() {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    // Only intercept calls to the (fake) Modal service; let calls to the local test server
    // (the router under test, reached via the client's own `call()` helper) go through for real.
    if (!url.startsWith('https://orpheus-clone.modal.run')) {
      return originalFetch(input, init);
    }
    const headers = (init?.headers as Record<string, string>) || {};
    const bodyText = typeof init?.body === 'string' ? init.body : init?.body ? Buffer.from(init.body as any).toString() : '';
    modalRequests.push({ method: init?.method || 'GET', url, authorization: headers['authorization'] ?? null, body: bodyText });
    return new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function uninstallFetchMock() {
  globalThis.fetch = originalFetch;
}

async function boot() {
  const { orpheusVoiceStudioApiKeyRouter } = await import('../src/routes/orpheusVoiceStudioApiKey.js');
  const app = express();
  app.use(express.json());
  app.use('/internal/orpheus-clone-api', orpheusVoiceStudioApiKeyRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/orpheus-clone-api`;

  const call = (headers: Record<string, string>, method: string, path: string, body?: object) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

  return { call, close: () => { server.close(); } };
}

test('missing x-gateway-admin-secret -> 401, Modal never called', async () => {
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

test('wrong x-gateway-admin-secret -> 401, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({ 'x-gateway-admin-secret': 'nope', 'x-gateway-uid': 'user-1' }, 'GET', '/v-1');
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0);
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('correct secret + x-gateway-uid -> POST / forwarded to Modal with bearer token', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(
      { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'user-42' },
      'POST',
      '/',
      { speaker_name: 'Test Speaker' }
    );
    assert.equal(res.status, 200);
    assert.equal(modalRequests.length, 1);
    assert.equal(modalRequests[0].method, 'POST');
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-voices');
    assert.equal(modalRequests[0].authorization, 'Bearer test-modal-secret');
    assert.equal(JSON.parse(modalRequests[0].body).speaker_name, 'Test Speaker');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('correct secret -> GET /:vid forwarded to Modal detail path', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(
      { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'user-42' },
      'GET',
      '/v-deadbeef00'
    );
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-voices/v-deadbeef00');
    assert.equal(modalRequests[0].authorization, 'Bearer test-modal-secret');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('correct secret -> DELETE /:vid forwarded to Modal delete path', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call(
      { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-key-id': 'key-1' },
      'DELETE',
      '/v-deadbeef00'
    );
    assert.equal(res.status, 200);
    assert.equal(modalRequests[0].method, 'DELETE');
    assert.equal(modalRequests[0].url, 'https://orpheus-clone.modal.run/v1/orpheus-voices/v-deadbeef00');
  } finally {
    close();
    uninstallFetchMock();
  }
});

test('correct secret but no identity headers -> 401, Modal never called', async () => {
  installFetchMock();
  modalRequests.length = 0;
  const { call, close } = await boot();
  try {
    const res = await call({ 'x-gateway-admin-secret': 'test-forward-secret' }, 'POST', '/', {});
    assert.equal(res.status, 401);
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
    // Unauthenticated PUT request (no x-gateway-admin-secret header).
    // Auth middleware runs before express.raw() buffers the body, so this should reject early.
    const res = await call({}, 'PUT', '/v-test123/dataset', { test: 'data' });
    assert.equal(res.status, 401);
    assert.equal(modalRequests.length, 0, 'Modal should not be called for unauthenticated requests');
  } finally {
    close();
    uninstallFetchMock();
  }
});
