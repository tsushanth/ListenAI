// npm test (node:test via tsx). POST/GET /deploy for voice-convert and voice-isolate: shared endpoint short-circuit,
// retry after `failed`, stale `deploying`, concurrent POST, late-finishing superseded deploy. The Modal CLI is
// stubbed through `modalOps`; Supabase is an in-memory table behind a patched global.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.GATEWAY_FORWARD_SECRET ??= 'test-forward-secret';
process.env.NODE_ENV = 'test';

let cfg: Record<string, string | undefined> = {};
async function loadCfg() { cfg = (await import('../lib/config.js')).config as unknown as Record<string, string | undefined>; }

type Row = { user_id: string; app_name: string; modal_url: string; modal_secret: string; status: string; job_count: number; updated_at: string };
let row: Row | null = null;
let insertConflict = false;
const patches: Array<Record<string, unknown>> = [];
const USER = 'aaaaaaaa-0000-0000-0000-000000000001';
const J = { 'Content-Type': 'application/json' };

const realFetch = globalThis.fetch;
function installFetch(table: string) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === 'http://localhost:54321/auth/v1/user') return new Response(JSON.stringify({ id: USER, aud: 'authenticated' }), { status: 200, headers: J });
    if (url.includes('/realtimetts_free_credits')) return new Response(JSON.stringify([{ granted: 10000, used: 0 }]), { status: 200, headers: J });
    if (url.includes('/rest/v1/realtimetts_billing')) return new Response(JSON.stringify([{ user_id: USER, active: true, stripe_customer_id: 'c', stripe_subscription_id: 's', stripe_subscription_item_id: 'i' }]), { status: 200, headers: J });
    if (url.includes(`/rest/v1/${table}`)) {
      const m = (init?.method || 'GET').toUpperCase();
      if (m === 'GET') return new Response(JSON.stringify(row), { status: 200, headers: J });
      if (m === 'POST') {
        if (insertConflict || row) return new Response(JSON.stringify({ code: '23505', message: 'duplicate key' }), { status: 409, headers: J });
        row = { ...JSON.parse(String(init?.body)), updated_at: new Date().toISOString() };
        return new Response('[]', { status: 201, headers: J });
      }
      if (m === 'PATCH') {
        const body = JSON.parse(String(init?.body));
        const q = new URL(url).searchParams;
        patches.push({ ...body, _app: q.get('app_name') });
        const app = q.get('app_name')?.replace(/^eq\./, '');
        if (row && (!app || app === row.app_name)) row = { ...row, ...body };
        return new Response('[]', { status: 200, headers: J });
      }
      if (m === 'DELETE') { row = null; return new Response('[]', { status: 200, headers: J }); }
    }
    return realFetch(input, init);
  };
}

async function boot(feature: 'convert' | 'isolate') {
  const mod = feature === 'convert' ? await import('./voiceConvert.js') : await import('./voiceIsolate.js');
  const router = feature === 'convert' ? (mod as typeof import('./voiceConvert.js')).voiceConvertRouter : (mod as typeof import('./voiceIsolate.js')).voiceIsolateRouter;
  const app = express();
  app.use(express.json());
  app.use('/api/x', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/x`;
  const call = (method: string, path: string) => fetch(base + path, { method, headers: { Authorization: 'Bearer valid-token' } });
  return { call, modalOps: (mod as { modalOps: { secretCreate: unknown; deploy: unknown; appStop: unknown } }).modalOps as Record<string, (...a: unknown[]) => Promise<void>>, close: () => server.close() };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

for (const feature of ['convert', 'isolate'] as const) {
  const table = `user_voice_${feature}_deployments`;
  const SHARED = feature === 'convert' ? ['VOICE_CONVERT_URL', 'VOICE_CONVERT_SECRET'] : ['VOICE_ISOLATE_URL', 'VOICE_ISOLATE_SECRET'];
  const setShared = (on: boolean) => { cfg[SHARED[0]] = on ? 'https://shared.example.modal.run' : undefined; cfg[SHARED[1]] = on ? 'shared-secret' : undefined; if (on) process.env.VOICE_SHARED_ENDPOINT = '1'; };
  const prep = async () => { await loadCfg(); installFetch(table); row = null; insertConflict = false; patches.length = 0; cfg.MODAL_TOKEN_ID = 'id'; cfg.MODAL_TOKEN_SECRET = 'sec'; delete process.env.VOICE_SHARED_ENDPOINT; };
  const done = () => { globalThis.fetch = realFetch; setShared(false); };
  const calls: string[] = [];
  const stub = (ops: Record<string, unknown>, fail = false) => {
    calls.length = 0;
    ops.secretCreate = async (n: string) => { calls.push(`secret:${n}`); };
    ops.deploy = async (s: string) => { calls.push(`deploy:${s}`); if (fail) throw new Error('modal deploy timed out'); };
    ops.appStop = async (a: string) => { calls.push(`stop:${a}`); };
  };

  test(`${feature}: shared endpoint configured -> POST /deploy returns 200 shared and runs NO modal command`, async () => {
    await prep(); setShared(true);
    const s = await boot(feature); stub(s.modalOps);
    const r = await s.call('POST', '/deploy');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ready', shared: true });
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(row, null, 'no per-user row is created');
    s.close(); done();
  });

  test(`${feature}: shared endpoint configured -> GET /deploy is 200 ready/shared, not 404`, async () => {
    await prep(); setShared(true);
    const s = await boot(feature);
    const r = await s.call('GET', '/deploy');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ready', shared: true });
    s.close(); done();
  });

  test(`${feature}: no shared endpoint, no row -> 202 deploying, deploy runs, row becomes ready`, async () => {
    await prep(); setShared(false);
    const s = await boot(feature); stub(s.modalOps);
    const r = await s.call('POST', '/deploy');
    assert.equal(r.status, 202);
    assert.equal((await r.json()).status, 'deploying');
    await settle();
    assert.ok(calls.some((c) => c.startsWith('deploy:-user-')));
    assert.equal(row?.status, 'ready');
    s.close(); done();
  });

  test(`${feature}: previous attempt FAILED -> POST /deploy retries (was a permanent 409)`, async () => {
    await prep(); setShared(false);
    row = { user_id: USER, app_name: `voice-${feature}-dev-user-aaaaaaaa-dead`, modal_url: 'u', modal_secret: 's', status: 'failed', job_count: 0, updated_at: new Date(Date.now() - 1000).toISOString() };
    const s = await boot(feature); stub(s.modalOps);
    const r = await s.call('POST', '/deploy');
    assert.equal(r.status, 202);
    await settle();
    assert.ok(calls.includes(`stop:voice-${feature}-dev-user-aaaaaaaa-dead`), 'old app stopped best-effort');
    assert.ok(calls.some((c) => c.startsWith('deploy:')));
    assert.notEqual(row?.app_name, `voice-${feature}-dev-user-aaaaaaaa-dead`);
    assert.equal(row?.status, 'ready');
    s.close(); done();
  });

  test(`${feature}: a deploy that fails marks the row failed, and a second POST then retries`, async () => {
    await prep(); setShared(false);
    const s = await boot(feature); stub(s.modalOps, true);
    assert.equal((await s.call('POST', '/deploy')).status, 202);
    await settle();
    assert.equal(row?.status, 'failed');
    stub(s.modalOps, false);
    assert.equal((await s.call('POST', '/deploy')).status, 202);
    await settle();
    assert.equal(row?.status, 'ready');
    s.close(); done();
  });

  test(`${feature}: ready row -> 409; fresh deploying row -> 409 in progress; stale deploying -> retried`, async () => {
    await prep(); setShared(false);
    const s = await boot(feature); stub(s.modalOps);
    row = { user_id: USER, app_name: 'a', modal_url: 'u', modal_secret: 's', status: 'ready', job_count: 0, updated_at: new Date().toISOString() };
    assert.equal((await s.call('POST', '/deploy')).status, 409);
    row = { ...row, status: 'deploying', updated_at: new Date(Date.now() - 30_000).toISOString() };
    const fresh = await s.call('POST', '/deploy');
    assert.equal(fresh.status, 409);
    assert.match((await fresh.json()).error, /in progress/);
    row = { ...row!, status: 'deploying', updated_at: new Date(Date.now() - 3600_000).toISOString() };
    assert.equal((await s.call('POST', '/deploy')).status, 202);
    await settle();
    assert.equal(calls.filter((c) => c.startsWith('deploy:')).length, 1);
    s.close(); done();
  });

  test(`${feature}: lost insert race (user_id primary key) -> 409 and no modal command`, async () => {
    await prep(); setShared(false); insertConflict = true;
    const s = await boot(feature); stub(s.modalOps);
    assert.equal((await s.call('POST', '/deploy')).status, 409);
    await settle();
    assert.deepEqual(calls, []);
    s.close(); done();
  });

  test(`${feature}: status updates are scoped to the app_name they belong to (a superseded attempt cannot overwrite its replacement)`, async () => {
    await prep(); setShared(false);
    const s = await boot(feature); stub(s.modalOps);
    await s.call('POST', '/deploy');
    await settle();
    assert.ok(patches.length >= 1);
    assert.ok(patches.every((p) => typeof p._app === 'string' && String(p._app).startsWith('eq.voice-')), JSON.stringify(patches));
    s.close(); done();
  });

  test(`${feature}: shared URL/secret configured but VOICE_SHARED_ENDPOINT unset -> still a per-user deploy (design), GET is 404 not a fake ready`, async () => {
    await prep(); setShared(true); delete process.env.VOICE_SHARED_ENDPOINT; // e.g. a stale VOICE_*_URL secret
    const s = await boot(feature); stub(s.modalOps);
    const g = await s.call('GET', '/deploy');
    assert.equal(g.status, 404);
    assert.equal((await s.call('POST', '/deploy')).status, 202);
    await settle();
    assert.ok(calls.some((c) => c.startsWith('deploy:')), 'per-user modal deploy runs');
    s.close(); done();
  });

  test(`${feature}: VOICE_SHARED_ENDPOINT=1 without the URL/secret configured -> per-user deploy, never a fake ready`, async () => {
    await prep(); setShared(false); process.env.VOICE_SHARED_ENDPOINT = '1';
    const s = await boot(feature); stub(s.modalOps);
    assert.equal((await s.call('POST', '/deploy')).status, 202);
    await settle();
    assert.ok(calls.some((c) => c.startsWith('deploy:')));
    s.close(); done();
  });
}
