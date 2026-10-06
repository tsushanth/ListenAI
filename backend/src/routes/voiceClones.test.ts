// Route-level tests: real express + real multipart over loopback, injected doubles for Supabase/Modal/ASR.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./voiceClones.js');
const svcP = import('../lib/voiceCloning/service.js');
const dblP = import('../lib/voiceCloning/testDoubles.js');
const polP = import('../lib/voiceCloning/policy.js');
import type { Eligibility } from '../lib/voiceCloning/types.js';

// Token format for the test resolver: "<userId>|<verified 0/1>|<paid|comped|none>"
function resolver(req: Request): Promise<Eligibility | null> {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!t) return Promise.resolve(null);
  const [userId, v, plan] = t.split('|');
  return Promise.resolve({ userId: userId!, emailVerified: v === '1', plan: plan === 'none' ? null : (plan as 'paid' | 'comped') });
}

async function boot(opts: { dark?: boolean; adminKey?: string | undefined } = {}) {
  const [{ createVoiceClonesRouter, createVoiceCloneAdminRouter }, { default: express }, dbl, pol] = await Promise.all([modP, import('express'), dblP, polP]);
  const store = new dbl.MemoryStore();
  const service = new dbl.FakeService();
  const asr = new dbl.FakeAsr();
  const deps = { store, blobs: new dbl.MemoryBlobs(), service, asr, policy: pol.DEFAULT_POLICY };
  const getDeps = () => (opts.dark ? null : deps);
  const app = express();
  app.use('/api/voice-clones', createVoiceClonesRouter({ getDeps, resolveEligibility: resolver }));
  app.use('/api/admin/voice-clones', createVoiceCloneAdminRouter({ getDeps, adminKey: () => ('adminKey' in opts ? opts.adminKey : 'sekret-admin') }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, store, service, asr, close: () => server.close() };
}

const AUTH = { Authorization: 'Bearer user-1|1|paid' };
const wavish = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'audio/wav' });

async function createVoice(ctx: Awaited<ReturnType<typeof boot>>, headers: Record<string, string> = AUTH, extra: Record<string, string> = {}) {
  const ch = await (await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers })).json() as { challenge_id: string; phrase: string };
  ctx.asr.heard = ch.phrase;
  const form = new FormData();
  form.append('challenge_id', extra.challenge_id ?? ch.challenge_id);
  form.append('name', 'Narrator');
  form.append('language', extra.language ?? 'en');
  form.append('consent', wavish(4000), 'consent.wav');
  form.append('reference', wavish(9000), 'ref.wav');
  return fetch(`${ctx.base}/api/voice-clones`, { method: 'POST', headers, body: form });
}

test('dark deployment: every user route is 503 and Supabase auth is never consulted', async () => {
  const ctx = await boot({ dark: true });
  try {
    const r = await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: AUTH });
    assert.equal(r.status, 503);
    assert.equal((await r.json() as { code: string }).code, 'unavailable');
    assert.equal((await fetch(`${ctx.base}/api/voice-clones`, { headers: AUTH })).status, 503);
  } finally { ctx.close(); }
});

test('auth: no token 401; unverified email 403; no payment 402', async () => {
  const ctx = await boot();
  try {
    assert.equal((await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST' })).status, 401);
    const unverified = await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: { Authorization: 'Bearer u|0|paid' } });
    assert.equal(unverified.status, 403);
    assert.equal((await unverified.json() as { code: string }).code, 'email_unverified');
    const unpaid = await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: { Authorization: 'Bearer u|1|none' } });
    assert.equal(unpaid.status, 402);
  } finally { ctx.close(); }
});

test('full flow: challenge -> create -> list -> delete; no audio or consent data in responses', async () => {
  const ctx = await boot();
  try {
    const created = await createVoice(ctx);
    assert.equal(created.status, 201);
    const body = await created.json() as Record<string, unknown>;
    assert.equal(body.status, 'active');
    assert.equal(body.model, 'chatterbox-mtl-v3');
    assert.deepEqual(Object.keys(body).sort(), ['created_at', 'id', 'language', 'model', 'name', 'reference_seconds', 'status']);

    const list = await (await fetch(`${ctx.base}/api/voice-clones`, { headers: AUTH })).json() as { voices: Array<{ id: string }> };
    assert.equal(list.voices.length, 1);
    assert.deepEqual(Object.keys(list.voices[0]!).sort(), ['created_at', 'id', 'language', 'name', 'status']);

    const other = await (await fetch(`${ctx.base}/api/voice-clones`, { headers: { Authorization: 'Bearer user-2|1|paid' } })).json() as { voices: unknown[] };
    assert.equal(other.voices.length, 0);

    const del = await fetch(`${ctx.base}/api/voice-clones/${body.id}`, { method: 'DELETE', headers: AUTH });
    assert.equal(del.status, 200);
    assert.ok(!ctx.service.voices.has(body.id as string));
    const forbidden = await fetch(`${ctx.base}/api/voice-clones/${body.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer user-2|1|paid' } });
    assert.equal(forbidden.status, 404);
    assert.equal((await fetch(`${ctx.base}/api/voice-clones/not-a-uuid`, { method: 'DELETE', headers: AUTH })).status, 400);
  } finally { ctx.close(); }
});

test('wrong speaker is a 422 speaker_mismatch and nothing is stored', async () => {
  const ctx = await boot();
  try {
    ctx.service.similarityValue = 0.05;
    const r = await createVoice(ctx);
    assert.equal(r.status, 422);
    assert.equal((await r.json() as { code: string }).code, 'speaker_mismatch');
    assert.equal(ctx.store.voices.size, 0);
  } finally { ctx.close(); }
});

test('missing files, bad language and non-audio uploads are rejected', async () => {
  const ctx = await boot();
  try {
    const ch = await (await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: AUTH })).json() as { challenge_id: string };
    const none = new FormData();
    none.append('challenge_id', ch.challenge_id);
    assert.equal((await fetch(`${ctx.base}/api/voice-clones`, { method: 'POST', headers: AUTH, body: none })).status, 400);
    const text = new FormData();
    text.append('challenge_id', ch.challenge_id);
    text.append('consent', new Blob([new Uint8Array(4000)], { type: 'text/plain' }), 'a.txt');
    text.append('reference', new Blob([new Uint8Array(4000)], { type: 'application/pdf' }), 'a.pdf');
    assert.equal((await fetch(`${ctx.base}/api/voice-clones`, { method: 'POST', headers: AUTH, body: text })).status, 400);
    const lang = await createVoice(ctx, AUTH, { language: 'xx' });
    assert.equal(lang.status, 400);
  } finally { ctx.close(); }
});

test('daily limit surfaces as 429 daily_limit on the 4th creation', async () => {
  const ctx = await boot();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await createVoice(ctx)).status, 201);
    const r = await createVoice(ctx);
    assert.equal(r.status, 429);
    assert.equal((await r.json() as { code: string }).code, 'daily_limit');
  } finally { ctx.close(); }
});

test('abuse report intake is public, validated, stored', async () => {
  const ctx = await boot();
  try {
    const bad = await fetch(`${ctx.base}/api/voice-clones/abuse-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact: 'a' }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${ctx.base}/api/voice-clones/abuse-reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'victim@example.com', category: 'impersonation', details: 'This voice impersonates me in scam calls.' }),
    });
    assert.equal(ok.status, 202);
    assert.equal(ctx.store.reports.length, 1);
  } finally { ctx.close(); }
});

test('admin takedown: needs the admin key, disables voice, purges outputs; unset key disables the router', async () => {
  const ctx = await boot();
  try {
    const created = await (await createVoice(ctx)).json() as { id: string };
    const url = `${ctx.base}/api/admin/voice-clones/${created.id}/disable`;
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers: json, body: JSON.stringify({ reason: 'x' }) })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...json, 'x-admin-key': 'wrong' }, body: JSON.stringify({ reason: 'x' }) })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...json, 'x-admin-key': 'sekret-admin' }, body: '{}' })).status, 400);
    const ok = await fetch(url, { method: 'POST', headers: { ...json, 'x-admin-key': 'sekret-admin' }, body: JSON.stringify({ reason: 'credible impersonation claim' }) });
    assert.equal(ok.status, 200);
    assert.equal(ctx.store.voices.get(created.id)!.status, 'disabled');
    assert.ok(ctx.service.disabled.has(created.id));
    const sweep = await fetch(`${ctx.base}/api/admin/voice-clones/purge-expired`, { method: 'POST', headers: { ...json, 'x-admin-key': 'sekret-admin' }, body: '{}' });
    assert.equal(sweep.status, 200);
  } finally { ctx.close(); }
  const noKey = await boot({ adminKey: undefined });
  try {
    const r = await fetch(`${noKey.base}/api/admin/voice-clones/purge-expired`, { method: 'POST', headers: { 'x-admin-key': '', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
  } finally { noKey.close(); }
});
