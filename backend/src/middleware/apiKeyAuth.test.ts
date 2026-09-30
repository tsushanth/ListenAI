// npm test (node:test via tsx), same pattern as middleware/rateLimit.test.ts and
// routes/voiceStudioApiKey.test.ts: boot a real express server with app.listen(0) and hit it over the
// network with fetch. verifyAuthTokenRemote calls Supabase's /auth/v1/user over HTTP (see lib/auth.ts) —
// rather than mocking the module, we point SUPABASE_URL at a local stub server, same spirit as
// realtimeTtsBilling.test.ts injecting fake deps: no real external call ever leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const FORWARD_SECRET = 'test-forward-secret';
const VALID_JWT = 'valid-jwt-for-user-1';
const JWT_USER_ID = 'user-jwt-1';

// Stub Supabase auth server: GET /auth/v1/user, 200 only for VALID_JWT, 401 otherwise.
function bootStubSupabase() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (req.url === '/auth/v1/user' && auth === `Bearer ${VALID_JWT}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: JWT_USER_ID }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid' }));
  });
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// Env must be set before the dynamic import (ES module imports are hoisted above plain statements),
// same constraint noted in rateLimit.test.ts / realtimeTtsBilling.test.ts.
async function boot(supabaseUrl: string) {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SUPABASE_JWT_SECRET = 'test';
  process.env.GATEWAY_FORWARD_SECRET = FORWARD_SECRET;
  process.env.NODE_ENV = 'test';

  // Force a fresh module graph so config.ts re-reads env each boot() call (tests run in one process).
  const [{ default: express }, { requireAuthOrApiKey }] = await Promise.all([
    import('express'),
    import(`./apiKeyAuth.js?t=${Date.now()}-${Math.random()}`),
  ]);
  const app = express();
  app.get('/whoami', requireAuthOrApiKey, (req: any, res: any) => {
    res.status(200).json({ userId: req.userId, authMethod: req.authMethod });
  });
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    close: () => server.close(),
    call: (headers: Record<string, string>) => fetch(`${base}/whoami`, { headers }),
  };
}

test('valid Supabase JWT passes and resolves the JWT-owned user id', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({ authorization: `Bearer ${VALID_JWT}` });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, JWT_USER_ID);
    assert.equal(body.authMethod, 'jwt');
  } finally {
    await app.close();
    stub.close();
  }
});

test('valid gateway-forwarded API key identity (uid) resolves to that uid, no JWT needed', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({
      'x-gateway-admin-secret': FORWARD_SECRET,
      'x-gateway-uid': 'user-from-key-42',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, 'user-from-key-42');
    assert.equal(body.authMethod, 'gateway-key');
  } finally {
    await app.close();
    stub.close();
  }
});

test('gateway-forwarded API key with no bound uid falls back to the key id as identity', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({
      'x-gateway-admin-secret': FORWARD_SECRET,
      'x-gateway-key-id': 'key-bare-7',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.userId, 'key-bare-7');
    assert.equal(body.authMethod, 'gateway-key');
  } finally {
    await app.close();
    stub.close();
  }
});

test('wrong forward secret is rejected even with an identity header present', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({ 'x-gateway-admin-secret': 'not-the-secret', 'x-gateway-uid': 'user-1' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
    stub.close();
  }
});

test('missing everything (no Authorization, no gateway headers) is rejected', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({});
    assert.equal(res.status, 401);
  } finally {
    await app.close();
    stub.close();
  }
});

test('invalid/expired JWT is rejected, not silently accepted', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({ authorization: 'Bearer this-is-not-a-real-token' });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
    stub.close();
  }
});

test('no silent fallback to a default/shared user: an invalid JWT never resolves to a userId, unlike requireAuth', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    // requireAuth (middleware/auth.ts) would resolve this to DEFAULT_PRO_USER_UUID; requireAuthOrApiKey
    // must not — the whole point of this middleware is that a billed/MCP-reachable route never falls
    // back to a shared identity.
    const res = await app.call({ authorization: 'Bearer garbage' });
    assert.equal(res.status, 401);
    const body = await res.json().catch(() => null);
    assert.ok(!body || typeof body.userId === 'undefined');
  } finally {
    await app.close();
    stub.close();
  }
});

test('a forward secret with neither uid nor key-id header is rejected, not treated as an identity', async () => {
  const stub = bootStubSupabase();
  const app = await boot(stub.url);
  try {
    const res = await app.call({ 'x-gateway-admin-secret': FORWARD_SECRET });
    assert.equal(res.status, 401);
  } finally {
    await app.close();
    stub.close();
  }
});
