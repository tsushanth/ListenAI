// npm test (node:test via tsx). Companion to apiKeyEverywhere.test.ts: the public rtts_ key (Bearer or xi-api-key)
// on the remaining billed REST families (voice conversion, voice isolation, sound effects, speech-to-text), through
// the REAL production middleware and REAL routers. Fixture keys only; gateway and Supabase are intercepted via a
// patched global.fetch, so nothing leaves the process and nothing is deployed or billed.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.GATEWAY_FORWARD_SECRET = 'test-forward-secret';
process.env.NODE_ENV = 'test';
process.env.STT_API_KEY = 'fixture-stt-key'; // lights up the speech-to-text router (dark without it); fixture only
process.env.REALTIME_TTS_GATEWAY_URL = 'http://gateway.test';
process.env.RTTS_KEY_AUTH_ENABLED = 'true';
process.env.RTTS_KEY_CACHE_TTL_MS = '0';

const KEY_PAID = 'rtts_fixturePaidAccountKey01';
const KEY_BROKE = 'rtts_fixtureBrokeAccountKey2';
const KEY_REVOKED = 'rtts_fixtureRevokedKeyXXXXX3';
const KEY_ORPHAN = 'rtts_fixtureOrphanKeyYYYYYY4';

const GATEWAY_IDS: Record<string, string> = { [KEY_PAID]: 'gk-paid', [KEY_BROKE]: 'gk-broke', [KEY_ORPHAN]: 'gk-orphan' };
const OWNER_OF_GATEWAY_ID: Record<string, string> = { 'gk-paid': 'acct-paid', 'gk-broke': 'acct-broke' };

const originalFetch = globalThis.fetch;
const billingLookups: string[] = [];
const restWrites: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();
  if (url === 'http://gateway.test/dubbing/authorize') {
    const key = JSON.parse(String(init?.body ?? '{}')).key as string;
    const id = GATEWAY_IDS[key];
    return id ? json({ authorized: true, id }) : json({ error: 'invalid or missing API key' }, 401);
  }
  if (url.startsWith('http://localhost:54321/auth/v1/user')) return json({ message: 'invalid' }, 401);
  if (url.startsWith('http://localhost:54321/rest/')) {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') { if (!u.pathname.includes('/rpc/get_')) restWrites.push(`${method} ${u.pathname}`); }
    const wantsObject = String(new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object');
    if (u.pathname.endsWith('/realtimetts_api_keys')) {
      const id = u.searchParams.get('gateway_key_id')?.replace(/^eq\./, '') ?? '';
      const owner = OWNER_OF_GATEWAY_ID[id];
      const rows = owner ? [{ user_id: owner }] : [];
      if (wantsObject) return rows.length ? json(rows[0]) : json({ code: 'PGRST116', message: 'none', details: '', hint: null }, 406);
      return json(rows);
    }
    if (u.pathname.endsWith('/realtimetts_billing')) {
      const uid = u.searchParams.get('user_id')?.replace(/^eq\./, '') ?? '';
      billingLookups.push(uid);
      return uid === 'acct-paid'
        ? json([{ user_id: uid, stripe_customer_id: 'cus_x', stripe_subscription_id: 'sub_x', stripe_subscription_item_id: 'si_x', active: true }])
        : json([]);
    }
    if (u.pathname.endsWith('/realtimetts_free_credits')) return json([{ granted: 10000, used: 10000 }]);
    if (wantsObject) return json({ code: 'PGRST116', message: 'none', details: '', hint: null }, 406);
    return json([]);
  }
  return originalFetch(input, init);
};

async function boot() {
  const [{ requireAuthOrApiKey }, { voiceConvertRouter }, { voiceIsolateRouter }, { soundEffectsRouter }, { sttRouter }, { errorHandler }] = await Promise.all([
    import('../middleware/apiKeyAuth.js'),
    import('./voiceConvert.js'),
    import('./voiceIsolate.js'),
    import('./soundEffects.js'),
    import('./stt.js'),
    import('../middleware/errorHandler.js'),
  ]);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Same mounts as index.ts (sound effects without its SOUND_EFFECTS_PUBLIC dark switch, which is a separate gate).
  app.use('/api/voice-convert', requireAuthOrApiKey, voiceConvertRouter);
  app.use('/api/voice-isolate', requireAuthOrApiKey, voiceIsolateRouter);
  app.use('/api/sound-effects', requireAuthOrApiKey, soundEffectsRouter);
  app.use('/api/stt', requireAuthOrApiKey, sttRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, headers: Record<string, string>, method = 'GET', body?: unknown) =>
    originalFetch(base + path, { method, headers: { 'Content-Type': 'application/json', Connection: 'close', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, close: () => server.close() };
}

const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const xi = (k: string) => ({ 'xi-api-key': k });
const notAuthError = (s: number) => ![401, 402, 403, 429, 503].includes(s);

// Read-only probes that reach each family's own handler without starting any work (no deploy, no job, no upload).
const PROBES: Array<[string, string]> = [
  ['voice conversion', '/api/voice-convert/deploy'],
  ['voice isolation', '/api/voice-isolate/deploy'],
  ['speech to text', '/api/stt/transcriptions'],
];

test('the paid account key (Bearer and xi-api-key) gets past auth and the billing gate on conversion, isolation and speech to text', async () => {
  const s = await boot();
  try {
    billingLookups.length = 0;
    for (const [name, path] of PROBES) {
      for (const h of [bearer(KEY_PAID), xi(KEY_PAID)]) {
        const r = await s.call(path, h);
        assert.ok(notAuthError(r.status), `${name} ${path}: got ${r.status} ${await r.clone().text()}`);
      }
    }
    assert.ok(billingLookups.length > 0 && billingLookups.every((u) => u === 'acct-paid'), `billing gate looked up ${billingLookups.join(',')}`);
  } finally { s.close(); }
});

test('conversion and isolation refuse a key whose owner has no billing and no free credits (402) before any deployment lookup', async () => {
  const s = await boot();
  try {
    restWrites.length = 0;
    for (const path of ['/api/voice-convert/deploy', '/api/voice-isolate/deploy']) {
      assert.equal((await s.call(path, bearer(KEY_BROKE))).status, 402, path);
      assert.equal((await s.call(path, xi(KEY_BROKE))).status, 402, path);
    }
    assert.equal(restWrites.length, 0, `writes happened for a refused caller: ${restWrites.join(', ')}`);
  } finally { s.close(); }
});

test('sound effects: the key reaches the route (400 on an empty body); a broke account gets 402 on a valid request and no job row is written', async () => {
  const s = await boot();
  try {
    restWrites.length = 0;
    assert.equal((await s.call('/api/sound-effects/job', bearer(KEY_PAID), 'POST', {})).status, 400);
    assert.equal((await s.call('/api/sound-effects/job', xi(KEY_PAID), 'POST', {})).status, 400);
    const r = await s.call('/api/sound-effects/job', bearer(KEY_BROKE), 'POST', { prompt: 'a wooden door slamming', duration_sec: 2 });
    assert.equal(r.status, 402);
    assert.deepEqual(restWrites.filter((w) => w.includes('sound_effect') && !w.includes('/rpc/get_')), [], 'no job row for a refused caller');
  } finally { s.close(); }
});

test('revoked, unlinked, missing, session-shaped and other-vendor credentials are refused on every family here', async () => {
  const s = await boot();
  try {
    restWrites.length = 0;
    const paths = [...PROBES.map(([, p]) => p), '/api/sound-effects/job'];
    for (const p of paths) {
      const m = p.endsWith('/job') ? 'POST' : 'GET';
      const body = m === 'POST' ? { prompt: 'a wooden door slamming', duration_sec: 2 } : undefined;
      assert.equal((await s.call(p, bearer(KEY_REVOKED), m, body)).status, 401, p);
      assert.equal((await s.call(p, xi(KEY_REVOKED), m, body)).status, 401, p);
      assert.equal((await s.call(p, bearer(KEY_ORPHAN), m, body)).status, 403, p);
      assert.equal((await s.call(p, {}, m, body)).status, 401, p);
      assert.equal((await s.call(p, bearer('Zm9vYmFy.not.ajwt'), m, body)).status, 401, p);
      assert.equal((await s.call(p, { 'xi-api-key': 'sk_0123456789abcdef0123456789abcdef' }, m, body)).status, 401, p);
    }
    assert.equal(restWrites.length, 0, `writes happened for refused callers: ${restWrites.join(', ')}`);
  } finally { s.close(); }
});

test('a key whose account fails the billing gate cannot start a conversion or isolation deployment (POST /deploy: 402, nothing written)', async () => {
  const s = await boot();
  try {
    restWrites.length = 0;
    for (const p of ['/api/voice-convert/deploy', '/api/voice-isolate/deploy']) {
      const r = await s.call(p, bearer(KEY_BROKE), 'POST', {});
      assert.equal(r.status, 402, p);
    }
    assert.equal(restWrites.length, 0);
  } finally { s.close(); }
});

test('the MCP gateway-forwarded identity still works through the same mounts', async () => {
  const s = await boot();
  try {
    const h = { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'acct-paid' };
    for (const [name, path] of PROBES) {
      const r = await s.call(path, h);
      assert.ok(notAuthError(r.status), `${name}: ${r.status}`);
    }
  } finally { s.close(); }
});

test.after(() => { globalThis.fetch = originalFetch; });
