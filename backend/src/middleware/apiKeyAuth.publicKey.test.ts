// npm test (node:test via tsx). The public rtts_ API key path of requireAuthOrApiKey (flag-gated, default OFF):
// accepted via "Authorization: Bearer rtts_..." and "xi-api-key"; rejected when invalid / revoked / wrong shape;
// rate limited; existing JWT and gateway-forwarded (MCP) paths unchanged; the key never appears in logs.
// The resolver is injected (its own behaviour is tested in lib/apiKeyResolver.test.ts). Fixture keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import pinoHttp from 'pino-http';
import express from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET = 'test-forward-secret';
process.env.NODE_ENV = 'test';

import type { KeyResolution } from '../lib/apiKeyResolver.js';
// Dynamic imports: static ones are hoisted above the env assignments, and config.ts validates env at import.
let mods: Promise<{
  createRequireAuthOrApiKey: typeof import('./apiKeyAuth.js').createRequireAuthOrApiKey;
  extractPublicApiKey: typeof import('./apiKeyAuth.js').extractPublicApiKey;
  apiKeyAuthEnabled: typeof import('./apiKeyAuth.js').apiKeyAuthEnabled;
  LOG_REDACT_PATHS: string[];
}> | undefined;
function load() {
  mods ??= Promise.all([import('./apiKeyAuth.js'), import('../lib/logger.js')]).then(([a, l]) => ({
    createRequireAuthOrApiKey: a.createRequireAuthOrApiKey,
    extractPublicApiKey: a.extractPublicApiKey,
    apiKeyAuthEnabled: a.apiKeyAuthEnabled,
    LOG_REDACT_PATHS: l.LOG_REDACT_PATHS,
  }));
  return mods;
}

const KEY_A = 'rtts_fixtureKeyAAAAAAAAAAAA';
const KEY_B = 'rtts_fixtureKeyBBBBBBBBBBBB';
const KEY_BAD = 'rtts_fixtureKeyInvalidXXXX';
const KEY_REVOKED = 'rtts_fixtureKeyRevokedXXXX';
const KEY_ORPHAN = 'rtts_fixtureKeyOrphanZZZZZ';
const KEY_EXHAUSTED = 'rtts_fixtureKeyExhaustedYY';
const KEY_DOWN = 'rtts_fixtureKeyUpstreamDown';

// Same eight mounts as index.ts (asserted against the real file in routeAuthGuard.test.ts).
const FAMILY_PATHS = ['/api/dub', '/api/voice-convert', '/api/voice-design', '/api/voice-isolate', '/api/audiobooks', '/api/sound-effects', '/api/stt', '/v1'];

function fakeResolver() {
  const calls: string[] = [];
  return {
    calls,
    resolve: async (key: string): Promise<KeyResolution> => {
      calls.push(key);
      if (key === KEY_A) return { ok: true, userId: 'user-A', keyId: 'gk-A' };
      if (key === KEY_B) return { ok: true, userId: 'user-B', keyId: 'gk-B' };
      if (key === KEY_EXHAUSTED) return { ok: false, status: 402, code: 'payment_required', message: 'used up' };
      if (key === KEY_ORPHAN) return { ok: false, status: 403, code: 'key_not_linked', message: 'not linked' };
      if (key === KEY_DOWN) return { ok: false, status: 503, code: 'key_check_unavailable', message: 'down' };
      return { ok: false, status: 401, code: 'invalid_api_key', message: 'Invalid or revoked API key.' }; // KEY_BAD, KEY_REVOKED, anything else
    },
  };
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, stream };
}

interface BootOpts { env?: Record<string, string>; now?: () => number; resolver?: ReturnType<typeof fakeResolver>; paths?: string[] }
async function boot(opts: BootOpts = {}) {
  const { createRequireAuthOrApiKey, LOG_REDACT_PATHS } = await load();
  const resolver = opts.resolver ?? fakeResolver();
  const cap = capture();
  const jwtSeen: string[] = [];
  const log = pino({ level: 'debug', redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } }, cap.stream);
  const env = { ...opts.env } as NodeJS.ProcessEnv;
  const mw = createRequireAuthOrApiKey({
    resolver, env, now: opts.now, log,
    verifyJwt: async (token) => {
      jwtSeen.push(token);
      if (token === 'valid-jwt') return { userId: 'user-jwt' };
      throw new Error(`bad jwt ${token}`);
    },
  });
  const app = express();
  app.set('trust proxy', 1);
  // Mirrors index.ts request logging so header redaction is exercised for real.
  app.use(pinoHttp({ logger: log, redact: LOG_REDACT_PATHS }));
  for (const p of opts.paths ?? FAMILY_PATHS) {
    app.use(p, mw, (req: any, res: any) => res.json({ userId: req.userId, authMethod: req.authMethod, apiKeyId: req.apiKeyId ?? null }));
  }
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { resolver, cap, jwtSeen, close: () => server.close(), call: (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers }) };
}

const ON = { RTTS_KEY_AUTH_ENABLED: 'true' };

test('flag default OFF: rtts_ bearer and xi-api-key are rejected on every family and never reach the resolver', async () => {
  const { apiKeyAuthEnabled } = await load();
  assert.equal(apiKeyAuthEnabled({}), false);
  assert.equal(apiKeyAuthEnabled({ RTTS_KEY_AUTH_ENABLED: 'false' }), false);
  const s = await boot({ env: {} });
  try {
    for (const p of FAMILY_PATHS) {
      assert.equal((await s.call(p, { authorization: `Bearer ${KEY_A}` })).status, 401, p);
      assert.equal((await s.call(p, { 'xi-api-key': KEY_A })).status, 401, p);
    }
    assert.equal(s.resolver.calls.length, 0);
    assert.equal(s.jwtSeen.length, 0, 'a public key is never sent to JWT verification (Supabase) either');
  } finally { s.close(); }
});

test('flag ON: the key is accepted on each REST family, as bearer and as xi-api-key, attributed to the key owner', async () => {
  const s = await boot({ env: ON });
  try {
    for (const p of FAMILY_PATHS) {
      for (const headers of [{ authorization: `Bearer ${KEY_A}` }, { 'xi-api-key': KEY_A }]) {
        const r = await s.call(p + '/x', headers);
        assert.equal(r.status, 200, p);
        assert.deepEqual(await r.json(), { userId: 'user-A', authMethod: 'api-key', apiKeyId: 'gk-A' });
      }
    }
    // Different key, different account: identity follows the key, not the process or the previous caller.
    const b = await (await s.call('/api/dub', { 'xi-api-key': KEY_B })).json();
    assert.equal(b.userId, 'user-B');
  } finally { s.close(); }
});

test('flag ON: invalid, revoked, unlinked, exhausted and unverifiable keys are refused with the right status on every family', async () => {
  const s = await boot({ env: { ...ON, RTTS_KEY_MAX_FAILURES_PER_5MIN: '1000' } });
  try {
    for (const p of FAMILY_PATHS) {
      assert.equal((await s.call(p, { authorization: `Bearer ${KEY_BAD}` })).status, 401, p);
      assert.equal((await s.call(p, { authorization: `Bearer ${KEY_REVOKED}` })).status, 401, p);
      assert.equal((await s.call(p, { 'xi-api-key': KEY_BAD })).status, 401, p);
      assert.equal((await s.call(p, { 'xi-api-key': KEY_ORPHAN })).status, 403, p);
      assert.equal((await s.call(p, { 'xi-api-key': KEY_EXHAUSTED })).status, 402, p);
      assert.equal((await s.call(p, { 'xi-api-key': KEY_DOWN })).status, 503, p);
    }
  } finally { s.close(); }
});

test('flag ON: a present xi-api-key with a wrong shape is a 401, never a fall-through to JWT or another identity', async () => {
  const s = await boot({ env: ON });
  try {
    const r = await s.call('/api/dub', { 'xi-api-key': 'sk_not_ours', authorization: 'Bearer valid-jwt' });
    assert.equal(r.status, 401);
    assert.equal((await s.call('/api/dub', { 'xi-api-key': '   ' })).status, 401, 'blank header and no JWT');
  } finally { s.close(); }
});

test('existing paths unchanged with the flag ON and OFF: session JWT passes, bad JWT is 401, no credentials is 401, no default user', async () => {
  for (const env of [{}, ON]) {
    const s = await boot({ env });
    try {
      const ok = await s.call('/api/dub', { authorization: 'Bearer valid-jwt' });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { userId: 'user-jwt', authMethod: 'jwt', apiKeyId: null });
      assert.equal((await s.call('/api/dub', { authorization: 'Bearer garbage' })).status, 401);
      assert.equal((await s.call('/api/dub')).status, 401);
      assert.equal(s.resolver.calls.length, 0, 'a JWT never goes to the key resolver');
    } finally { s.close(); }
  }
});

test('existing MCP path unchanged: gateway-forwarded identity wins and never touches the key resolver', async () => {
  for (const env of [{}, ON]) {
    const s = await boot({ env });
    try {
      const r = await s.call('/api/voice-convert', { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'user-mcp' });
      assert.deepEqual(await r.json(), { userId: 'user-mcp', authMethod: 'gateway-key', apiKeyId: null });
      // Forward headers present but wrong secret, plus a valid key: the bad secret is ignored, the key still authenticates as itself.
      const r2 = await s.call('/api/voice-convert', { 'x-gateway-admin-secret': 'wrong', 'x-gateway-uid': 'user-evil', authorization: `Bearer ${KEY_A}` });
      assert.equal(r2.status, env === ON ? 200 : 401);
      if (env === ON) assert.equal((await r2.json()).userId, 'user-A', 'identity headers are never trusted without the secret');
      assert.equal(s.resolver.calls.filter((k) => k !== KEY_A).length, 0);
    } finally { s.close(); }
  }
});

test('rate limiting: per-account ceiling across all families and keys of one account', async () => {
  const s = await boot({ env: { ...ON, RTTS_KEY_RATE_PER_MIN: '3' } });
  try {
    const out: number[] = [];
    for (const p of ['/api/dub', '/api/stt', '/v1', '/api/audiobooks']) out.push((await s.call(p, { 'xi-api-key': KEY_A })).status);
    assert.deepEqual(out, [200, 200, 200, 429]);
    const limited = await s.call('/api/dub', { authorization: `Bearer ${KEY_A}` });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await s.call('/api/dub', { 'xi-api-key': KEY_B })).status, 200, 'another account is unaffected');
  } finally { s.close(); }
});

test('rate limiting: the account window slides (requests allowed again after a minute)', async () => {
  let t = 5_000_000;
  const s = await boot({ env: { ...ON, RTTS_KEY_RATE_PER_MIN: '1' }, now: () => t });
  try {
    assert.equal((await s.call('/api/dub', { 'xi-api-key': KEY_A })).status, 200);
    assert.equal((await s.call('/api/dub', { 'xi-api-key': KEY_A })).status, 429);
    t += 61_000;
    assert.equal((await s.call('/api/dub', { 'xi-api-key': KEY_A })).status, 200);
  } finally { s.close(); }
});

test('rate limiting: repeated invalid keys from one address are cut off before the resolver is called', async () => {
  const s = await boot({ env: { ...ON, RTTS_KEY_MAX_FAILURES_PER_5MIN: '3' } });
  try {
    const out: number[] = [];
    for (let i = 0; i < 5; i++) out.push((await s.call('/api/dub', { 'xi-api-key': `rtts_guess${i}xxxxxxxxxxxxxx` })).status);
    assert.deepEqual(out, [401, 401, 401, 429, 429]);
    assert.equal(s.resolver.calls.length, 3, 'blocked attempts never reach the gateway');
    // Outages and billing rejections are not guessing and do not count against the address.
    const s2 = await boot({ env: { ...ON, RTTS_KEY_MAX_FAILURES_PER_5MIN: '2' } });
    try {
      for (let i = 0; i < 4; i++) assert.equal((await s2.call('/api/dub', { 'xi-api-key': KEY_EXHAUSTED })).status, 402);
    } finally { s2.close(); }
  } finally { s.close(); }
});

test('no key ever logged: not in middleware logs, not in request logs, on success or any failure path', async () => {
  const s = await boot({ env: ON });
  try {
    const keys = [KEY_A, KEY_BAD, KEY_REVOKED, KEY_ORPHAN, KEY_EXHAUSTED, KEY_DOWN];
    for (const k of keys) {
      await (await s.call('/api/dub', { authorization: `Bearer ${k}` })).text();
      await (await s.call('/api/stt', { 'xi-api-key': k })).text();
    }
    await (await s.call('/api/dub', { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'u' })).text();
    await new Promise((r) => setTimeout(r, 50));
    const all = s.cap.lines.join('');
    assert.ok(all.length > 200, 'request logs were actually produced');
    assert.ok(/\[redacted\]/i.test(all), 'headers were redacted, not absent');
    for (const k of keys) assert.ok(!all.includes(k), `key ${k.slice(0, 18)} leaked into logs`);
    assert.ok(!all.includes('test-forward-secret'));
  } finally { s.close(); }
});

test('the shared redaction list covers every credential-carrying request header', async () => {
  const { LOG_REDACT_PATHS } = await load();
  for (const must of ['req.headers.authorization', 'req.headers["xi-api-key"]', 'req.headers["x-gateway-admin-secret"]', 'req.headers.cookie']) {
    assert.ok(LOG_REDACT_PATHS.includes(must), must);
  }
});

test('extractPublicApiKey: bearer rtts_ or xi-api-key only; a JWT bearer is not a key', async () => {
  const { extractPublicApiKey } = await load();
  const req = (h: Record<string, string>) => ({ headers: h }) as any;
  assert.equal(extractPublicApiKey(req({ authorization: `Bearer ${KEY_A}` })), KEY_A);
  assert.equal(extractPublicApiKey(req({ authorization: `bearer   ${KEY_A}  ` })), KEY_A);
  assert.equal(extractPublicApiKey(req({ 'xi-api-key': KEY_A })), KEY_A);
  assert.equal(extractPublicApiKey(req({ authorization: 'Bearer eyJhbGciOi.jwt.sig' })), null);
  assert.equal(extractPublicApiKey(req({})), null);
  assert.equal(extractPublicApiKey(req({ authorization: `Basic ${KEY_A}` })), null);
});
