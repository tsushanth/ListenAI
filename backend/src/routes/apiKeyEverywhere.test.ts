// npm test (node:test via tsx). End to end through the REAL production middleware and REAL routers: the public
// rtts_ key (Bearer or xi-api-key) authenticates voice design, dubbing and audiobooks, and the work, billing
// gate and job rows are attributed to the account that owns the key. Gateway, Supabase and the Modal worker are
// all intercepted via a patched global.fetch; fixture keys only, nothing leaves the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
process.env.SUPABASE_JWT_SECRET = 'test';
process.env.GATEWAY_FORWARD_SECRET = 'test-forward-secret';
process.env.NODE_ENV = 'test';
process.env.VOICE_DESIGN_URL = 'http://127.0.0.1:9999';
process.env.VOICE_DESIGN_SECRET = 'modal-secret';
process.env.STT_API_KEY = 'fixture-stt-key'; // lights up the dubbing router (dark without them); fixtures only
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key';
process.env.REALTIME_TTS_GATEWAY_URL = 'http://gateway.test';
process.env.RTTS_KEY_AUTH_ENABLED = 'true';
process.env.RTTS_KEY_CACHE_TTL_MS = '0'; // every request re-checks the gateway, so revocation is immediate in these tests

const KEY_PAID = 'rtts_fixturePaidAccountKey01';      // account "acct-paid": billing active
const KEY_BROKE = 'rtts_fixtureBrokeAccountKey2';     // account "acct-broke": no billing, no free credits
const KEY_REVOKED = 'rtts_fixtureRevokedKeyXXXXX3';   // gateway says 401
const KEY_ORPHAN = 'rtts_fixtureOrphanKeyYYYYYY4';    // gateway accepts, no account record
const KEY_REVOKED_IN_CONSOLE = 'rtts_fixtureConsoleRevoked5'; // gateway still accepts, ownership row revoked

const GATEWAY_IDS: Record<string, string> = {
  [KEY_PAID]: 'gk-paid', [KEY_BROKE]: 'gk-broke', [KEY_ORPHAN]: 'gk-orphan', [KEY_REVOKED_IN_CONSOLE]: 'gk-console-revoked',
};
const OWNER_OF_GATEWAY_ID: Record<string, string> = { 'gk-paid': 'acct-paid', 'gk-broke': 'acct-broke' }; // live rows only

const originalFetch = globalThis.fetch;
const gatewayCalls: string[] = [];
const designInserts: Array<Record<string, unknown>> = [];
const billingLookups: string[] = [];
const modalPosts: unknown[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  if (url === 'http://gateway.test/dubbing/authorize') {
    const key = JSON.parse(String(init?.body ?? '{}')).key as string;
    gatewayCalls.push(url);
    const id = GATEWAY_IDS[key];
    return id ? json({ authorized: true, id }) : json({ error: 'invalid or missing API key' }, 401);
  }

  if (url.startsWith('http://localhost:54321/auth/v1/user')) return json({ message: 'invalid' }, 401);

  if (url.startsWith('http://localhost:54321/rest/')) {
    const u = new URL(url);
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
    if (u.pathname.endsWith('/realtimetts_free_credits')) return json([{ granted: 10000, used: 10000 }]); // exhausted for everyone
    if (u.pathname.endsWith('/voice_design_jobs') && init?.method === 'POST') {
      designInserts.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 201 });
    }
    return json([]);
  }

  if (url === 'http://127.0.0.1:9999/designs' && init?.method === 'POST') {
    modalPosts.push(JSON.parse(String(init.body)));
    return json({ job_id: 'job-1', status: 'queued' }, 201);
  }

  return originalFetch(input, init);
};

async function boot() {
  const [{ requireAuthOrApiKey }, { voiceDesignRouter }, { dubRouter }, { audiobooksRouter }, { errorHandler }] = await Promise.all([
    import('../middleware/apiKeyAuth.js'),
    import('./voiceDesign.js'),
    import('./dub.js'),
    import('./audiobooks.js'),
    import('../middleware/errorHandler.js'),
  ]);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Same mounts as index.ts.
  app.use('/api/voice-design', requireAuthOrApiKey, voiceDesignRouter);
  app.use('/api/dub', requireAuthOrApiKey, dubRouter);
  app.use('/api/audiobooks', requireAuthOrApiKey, audiobooksRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, headers: Record<string, string>, method = 'POST', body: unknown = { description: 'A warm, friendly narrator for audiobooks', text: 'Hello world' }) =>
    originalFetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { call, close: () => server.close() };
}

const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
const xi = (k: string) => ({ 'xi-api-key': k });

test('voice design: the paid account key works as Bearer and as xi-api-key; the job row and billing gate are the key owner\'s', async () => {
  const s = await boot();
  try {
    designInserts.length = 0; billingLookups.length = 0; modalPosts.length = 0;
    for (const h of [bearer(KEY_PAID), xi(KEY_PAID)]) {
      const r = await s.call('/api/voice-design/designs', h);
      assert.equal(r.status, 201, await r.clone().text());
      assert.equal((await r.json()).job_id, 'job-1');
    }
    assert.equal(designInserts.length, 2);
    assert.ok(designInserts.every((row) => row.user_id === 'acct-paid'), 'job rows belong to the key owner');
    assert.ok(billingLookups.length >= 2 && billingLookups.every((u) => u === 'acct-paid'), `billing gate looked up ${billingLookups.join(',')}`);
    assert.equal(modalPosts.length, 2);
  } finally { s.close(); }
});

test('wrong account: a key whose owner has no billing and no free credits gets 402 on voice design and dubbing, nothing is queued', async () => {
  const s = await boot();
  try {
    designInserts.length = 0; modalPosts.length = 0;
    const d = await s.call('/api/voice-design/designs', bearer(KEY_BROKE));
    assert.equal(d.status, 402);
    const dub = await s.call('/api/dub', xi(KEY_BROKE), 'POST', {});
    assert.equal(dub.status, 402);
    assert.equal(designInserts.length, 0);
    assert.equal(modalPosts.length, 0);
    // Same endpoint, the paid account's key gets past the gate (400: no audio file) - the gate is per account, not per process.
    const ok = await s.call('/api/dub', xi(KEY_PAID), 'POST', {});
    assert.equal(ok.status, 400);
  } finally { s.close(); }
});

test('dubbing and audiobooks accept the key and reach their own validation (400), not an auth error', async () => {
  const s = await boot();
  try {
    assert.equal((await s.call('/api/dub', bearer(KEY_PAID), 'POST', {})).status, 400);
    assert.equal((await s.call('/api/audiobooks', xi(KEY_PAID), 'POST', {})).status, 400);
    assert.equal((await s.call('/api/audiobooks', bearer(KEY_PAID), 'POST', {})).status, 400);
  } finally { s.close(); }
});

test('revoked at the gateway, revoked in the console, and not linked to an account are all refused on every covered family', async () => {
  const s = await boot();
  try {
    designInserts.length = 0; modalPosts.length = 0;
    for (const p of ['/api/voice-design/designs', '/api/dub', '/api/audiobooks']) {
      assert.equal((await s.call(p, bearer(KEY_REVOKED))).status, 401, p);
      assert.equal((await s.call(p, xi(KEY_REVOKED))).status, 401, p);
      assert.equal((await s.call(p, bearer(KEY_REVOKED_IN_CONSOLE))).status, 403, p);
      assert.equal((await s.call(p, bearer(KEY_ORPHAN))).status, 403, p);
      assert.equal((await s.call(p, {})).status, 401, p);
      assert.equal((await s.call(p, bearer('Zm9vYmFy.not.ajwt'))).status, 401, p);
    }
    assert.equal(designInserts.length + modalPosts.length, 0, 'no work was started for any rejected caller');
  } finally { s.close(); }
});

test('a wrong-shaped xi-api-key (another vendor\'s key) never falls through to an identity', async () => {
  const s = await boot();
  try {
    const r = await s.call('/api/voice-design/designs', { 'xi-api-key': 'sk_0123456789abcdef0123456789abcdef' });
    assert.equal(r.status, 401);
  } finally { s.close(); }
});

test('existing MCP path still works through the same mounts (gateway-forwarded identity)', async () => {
  const s = await boot();
  try {
    designInserts.length = 0;
    // The MCP-forwarded identity is a bare id; give it billing by using the paid account's uid.
    const r = await s.call('/api/voice-design/designs', { 'x-gateway-admin-secret': 'test-forward-secret', 'x-gateway-uid': 'acct-paid' });
    assert.equal(r.status, 201);
    assert.equal(designInserts[0]?.user_id, 'acct-paid');
  } finally { s.close(); }
});

test.after(() => { globalThis.fetch = originalFetch; });
