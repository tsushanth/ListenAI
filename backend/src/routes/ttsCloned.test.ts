// /api/tts/cloned and /job-cloned only accept consent-verified voices owned by the caller. Run with
// --experimental-test-module-mocks (see npm test). Supabase/Modal/ASR are doubles; no network.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { Eligibility } from '../lib/voiceCloning/types.js';
const state: { deps: unknown; plan: 'paid' | 'comped' | null } = { deps: null, plan: 'paid' };

mock.module('../lib/voiceCloning/runtime.js', {
  namedExports: {
    getCloneDeps: () => state.deps,
    eligibilityForSynthesis: async (userId: string): Promise<Eligibility> => ({ userId, emailVerified: true, plan: state.plan }),
  },
});

async function boot() {
  const [{ default: express }, { ttsRouter }, { errorHandler }, dbl, pol] = await Promise.all([
    import('express'), import('./tts.js'), import('../middleware/errorHandler.js'),
    import('../lib/voiceCloning/testDoubles.js'), import('../lib/voiceCloning/policy.js'),
  ]);
  const store = new dbl.MemoryStore();
  const service = new dbl.FakeService();
  state.deps = { store, blobs: new dbl.MemoryBlobs(), service, asr: new dbl.FakeAsr(), policy: pol.DEFAULT_POLICY };
  state.plan = 'paid';
  const mkVoice = async (id: string, userId: string, status: 'active' | 'disabled' = 'active') => {
    await store.insertVoice({ id, userId, name: 'v', language: 'es', status, consentId: 'c', referenceSha256: 'x', referenceSec: 10, modelId: 'chatterbox-mtl-v3', disabledReason: null, disabledAt: null, deletedAt: null, createdAt: new Date().toISOString() });
  };
  const app = express();
  app.use(express.json());
  app.use('/api/tts', (req: Request, _res: Response, next: NextFunction) => { (req as Request & { user: { id: string } }).user = { id: (req.headers['x-test-user'] as string) || 'user-1' }; next(); }, ttsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tts`;
  return { base, store, service, mkVoice, close: () => server.close() };
}

const VID = '11111111-1111-4111-8111-111111111111';
const post = (base: string, path: string, body: unknown, user = 'user-1') =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) });

test('/cloned synthesises an owned active voice in its language, returns watermark headers, records the output hash', async () => {
  const ctx = await boot();
  try {
    await ctx.mkVoice(VID, 'user-1');
    const r = await post(ctx.base, '/cloned', { text: 'Hola mundo', voice_id: VID });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-watermark'), 'applied'); // the scheme name is not public; the stored record below keeps it
    assert.equal(r.headers.get('x-model'), 'studio');
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    assert.ok(ctx.service.calls.includes('synthesize'));
    assert.equal(ctx.store.outputs.length, 1);
    assert.equal(ctx.store.outputs[0]!.voiceId, VID);
    assert.equal(ctx.store.outputs[0]!.watermarkScheme, 'perth');
  } finally { ctx.close(); }
});

test('/cloned ignores a client-supplied voice_url (no reference audio is taken from the request)', async () => {
  const ctx = await boot();
  try {
    await ctx.mkVoice(VID, 'user-1');
    const r = await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID, voice_url: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(r.status, 200);
  } finally { ctx.close(); }
});

test('/cloned refuses: unknown voice 404, someone else\'s voice 404, disabled 403, cancelled plan 402, retired model name 400, bad id 400', async () => {
  const ctx = await boot();
  try {
    await ctx.mkVoice(VID, 'user-1');
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: '22222222-2222-4222-8222-222222222222' })).status, 404);
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID }, 'intruder')).status, 404);
    state.plan = null;
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID })).status, 402);
    state.plan = 'paid';
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID, model: ['x', 'tts'].join('') })).status, 400);
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: 'legacy-device-voice' })).status, 400);
    await ctx.store.setVoiceStatus(VID, { status: 'disabled' });
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID })).status, 403);
    assert.ok(!ctx.service.calls.includes('synthesize'));
  } finally { ctx.close(); }
});

test('/cloned is 503 when cloning is not configured', async () => {
  const ctx = await boot();
  try {
    state.deps = null;
    assert.equal((await post(ctx.base, '/cloned', { text: 'hi', voice_id: VID })).status, 503);
  } finally { ctx.close(); }
});

test('/job-cloned checks the voice before creating any job (disabled voice -> 403, someone else\'s -> 404)', async () => {
  const ctx = await boot();
  try {
    await ctx.mkVoice(VID, 'user-1', 'disabled');
    assert.equal((await post(ctx.base, '/job-cloned', { text: 'hi', voice_id: VID })).status, 403);
    assert.equal((await post(ctx.base, '/job-cloned', { text: 'hi', voice_id: VID }, 'intruder')).status, 404);
  } finally { ctx.close(); }
});

test('no request header can skip the quota: a signed-in account over its limit is refused, X-Debug-Bypass-Quota included', async () => {
  const realFetch = globalThis.fetch;
  const rpc: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('http://localhost:54321')) return realFetch(input, init);
    if (url.includes('/rpc/can_synthesize_v2')) { rpc.push(url); return json([{ allowed: false, reason: 'Daily audio limit exceeded.' }]); }
    return json([]); // no subscription row: free tier
  }) as typeof fetch;
  const ctx = await boot();
  try {
    await ctx.mkVoice(VID, 'user-1');
    const send = (headers: Record<string, string>) => fetch(`${ctx.base}/job-cloned`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1', ...headers }, body: JSON.stringify({ text: 'hi', voice_id: VID }) });
    const plain = await send({});
    const bypass = await send({ 'X-Debug-Bypass-Quota': 'true' });
    assert.equal(plain.status, 402);
    assert.equal(bypass.status, 402);
    assert.match(JSON.stringify(await bypass.json()), /Daily audio limit exceeded/);
    assert.equal(rpc.length, 2, 'the quota was checked both times');
    const long = await fetch(`${ctx.base}/job-cloned`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'user-1', 'X-Debug-Bypass-Quota': 'true' }, body: JSON.stringify({ text: 'a'.repeat(30_000), voice_id: VID }) });
    assert.equal(long.status, 400, 'the per-job length limit applies too');
  } finally { ctx.close(); globalThis.fetch = realFetch; }
});

test('the bypass header is read nowhere in the backend or the Android app', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const hits: string[] = [];
  const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|kt)$/.test(e.name) && !e.name.endsWith('.test.ts') && /x-debug-bypass-quota/i.test(readFileSync(p, 'utf8'))) hits.push(p); } };
  walk(join(root, 'backend', 'src'));
  walk(join(root, 'android', 'app', 'src', 'main'));
  assert.deepEqual(hits, []);
});

