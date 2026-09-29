// npm test  (node:test via tsx; intake is mocked in memory, nothing leaves the process)
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createVoiceStudioRouter, CONSENT_TEXT_VERSION, VoiceStudioDeps } from './voiceStudioRouter.js';
import { IntakeClient, IntakeError, IntakeVoiceStatus } from '../lib/voiceIntakeClient.js';

function fakeIntake() {
  const voices = new Map<string, IntakeVoiceStatus & { parts: Map<number, number> }>();
  const calls: string[] = [];
  let n = 0;
  const need = (id: string) => {
    const v = voices.get(id);
    if (!v) throw new IntakeError(404, 'unknown voice');
    return v;
  };
  const intake: IntakeClient = {
    async create(b) {
      calls.push('create');
      const id = `v-${(++n).toString(16).padStart(10, '0')}`;
      voices.set(id, { voice_id: id, status: 'created', owner_user_id: b.owner_user_id as string, speaker_name: b.speaker_name as string, created_at: 1, parts: new Map(), ...({ consent: b } as object) });
      return { voice_id: id };
    },
    async list(u) {
      return { voices: [...voices.values()].filter((v) => v.owner_user_id === u).map(({ parts: _p, ...v }) => v) };
    },
    async get(id) { calls.push('get'); const { parts: _p, ...v } = need(id); return v; },
    async putPart(id, i, data) { calls.push('putPart'); need(id).parts.set(i, data.length); return { part: i, bytes: data.length }; },
    async listParts(id) { return { parts: [...need(id).parts].map(([part, bytes]) => ({ part, bytes })) }; },
    async commit(id, parts) { const v = need(id); v.status = 'training'; calls.push('commit'); return { voice_id: id, status: 'training', clips: parts }; },
    async sample(id, i) { need(id); return Buffer.from(`wav-${i}`); },
    async preview(id, text) { need(id); return Buffer.from(`wav:${text}`); },
    async deploy(id) { calls.push('deploy'); need(id).status = 'deployed'; return { voice_id: id, voice: `custom:${id}` }; },
    async remove(id) { calls.push('remove'); need(id); voices.delete(id); return { deleted: id }; },
  };
  return { intake, voices, calls };
}

async function boot(over: Partial<VoiceStudioDeps> & { enabled?: string } = {}) {
  const f = fakeIntake();
  const backfilled: string[] = [];
  const deps: VoiceStudioDeps = {
    authenticate: async (req) => {
      const h = req.headers.authorization ?? '';
      return h.startsWith('Bearer user-') ? h.slice(7) : null;
    },
    intake: f.intake,
    enabledUsers: () => over.enabled ?? '*',
    maxVoicesPerUser: 3,
    maxZipBytes: 1024,
    backfillKeyOwners: async (u) => { backfilled.push(u); },
    ...over,
  };
  const app = express();
  app.use('/api/voice-studio', createVoiceStudioRouter(deps));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice-studio`;
  const call = (as: string | null, method: string, path: string, body?: unknown, raw?: Buffer) =>
    fetch(base + path, {
      method,
      headers: { ...(as ? { Authorization: `Bearer ${as}` } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined,
    });
  return { call, f, backfilled, close: () => server.close() };
}

const consent = { speaker_name: 'Ana Ruiz', attested_by: 'Ana Ruiz', consent: true, consent_text_version: CONSENT_TEXT_VERSION };

test('feature off by default: everything 404s, even unauthenticated', async () => {
  const s = await boot({ enabled: '' });
  for (const [m, p] of [['GET', '/'], ['GET', '/enabled'], ['POST', '/'], ['GET', '/v-0000000001']] as Array<[string, string]>) {
    assert.equal((await s.call(null, m, p)).status, 404, `${m} ${p}`);
    assert.equal((await s.call('user-a', m, p)).status, 404, `${m} ${p} authed`);
  }
  s.close();
});

test('allowlist: listed user in, others 404, no token 401', async () => {
  const s = await boot({ enabled: 'user-a, user-c' });
  assert.equal((await s.call('user-a', 'GET', '/enabled')).status, 200);
  assert.equal((await s.call('user-b', 'GET', '/enabled')).status, 404);
  assert.equal((await s.call(null, 'GET', '/enabled')).status, 401);
  s.close();
});

test('create records consent, validates it, caps voices, backfills key owners', async () => {
  const s = await boot();
  assert.equal((await s.call('user-a', 'POST', '/', { ...consent, consent: false })).status, 400);
  assert.equal((await s.call('user-a', 'POST', '/', { ...consent, consent_text_version: 'old' })).status, 400);
  assert.equal((await s.call('user-a', 'POST', '/', { ...consent, speaker_name: 'x' })).status, 400);
  const ok = await s.call('user-a', 'POST', '/', consent);
  assert.equal(ok.status, 201);
  const stored = [...s.f.voices.values()][0]! as unknown as { consent: Record<string, unknown> };
  assert.equal(stored.consent.owner_user_id, 'user-a');
  assert.equal(stored.consent.consent_text_version, CONSENT_TEXT_VERSION);
  assert.equal(stored.consent.attested_by, 'Ana Ruiz');
  assert.deepEqual(s.backfilled, ['user-a']);
  await s.call('user-a', 'POST', '/', consent);
  await s.call('user-a', 'POST', '/', consent);
  const fourth = await s.call('user-a', 'POST', '/', consent);
  assert.equal(fourth.status, 429);
  assert.equal((await s.call('user-b', 'POST', '/', consent)).status, 201, 'cap is per user');
  s.close();
});

test('rejected voices do not count toward the cap', async () => {
  const s = await boot();
  for (let i = 0; i < 3; i++) await s.call('user-a', 'POST', '/', consent);
  [...s.f.voices.values()][0]!.status = 'rejected';
  assert.equal((await s.call('user-a', 'POST', '/', consent)).status, 201);
  s.close();
});

test('OWNERSHIP: user B cannot read, upload to, preview, sample, deploy or delete user A\'s voice (404, intake never mutated)', async () => {
  const s = await boot();
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  const v = s.f.voices.get(id)!; v.status = 'ready';
  const before = s.f.calls.filter((c) => c !== 'get' && c !== 'create').length;
  const attempts: Array<[string, string, unknown?, Buffer?]> = [
    ['GET', `/${id}`], ['GET', `/${id}/samples/0`], ['POST', `/${id}/preview`, { text: 'hi' }], ['POST', `/${id}/deploy`],
    ['DELETE', `/${id}`], ['PUT', `/${id}/dataset/parts/0`, undefined, Buffer.from('zz')], ['GET', `/${id}/dataset/parts`],
    ['POST', `/${id}/dataset/commit`, { parts: 1 }],
  ];
  for (const [m, p, b, raw] of attempts) {
    const r = await s.call('user-b', m, p, b, raw);
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  assert.equal(s.f.calls.filter((c) => c !== 'get' && c !== 'create').length, before, 'no mutating intake call happened');
  assert.equal(s.f.voices.has(id), true);
  // and the owner can
  assert.equal((await s.call('user-a', 'GET', `/${id}`)).status, 200);
  assert.equal((await s.call('user-a', 'DELETE', `/${id}`)).status, 200);
  s.close();
});

test('unknown, malformed and foreign ids are indistinguishable; list only returns own voices', async () => {
  const s = await boot();
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  const foreign = await s.call('user-b', 'GET', `/${id}`);
  const unknown = await s.call('user-b', 'GET', '/v-ffffffffff');
  const malformed = await s.call('user-b', 'GET', '/..%2f..%2fetc');
  assert.deepEqual([foreign.status, unknown.status, malformed.status], [404, 404, 404]);
  assert.equal(await foreign.text(), await unknown.text());
  const listB = (await (await s.call('user-b', 'GET', '/')).json()) as { voices: unknown[] };
  assert.equal(listB.voices.length, 0);
  const listA = (await (await s.call('user-a', 'GET', '/')).json()) as { voices: Array<Record<string, unknown>> };
  assert.equal(listA.voices.length, 1);
  assert.equal('owner_user_id' in listA.voices[0]!, false, 'owner ids are not exposed');
  s.close();
});

test('upload flow: parts -> commit; size limit; only while status is created', async () => {
  const s = await boot({ maxZipBytes: 100 });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  assert.equal((await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(60))).status, 200);
  assert.equal((await s.call('user-a', 'PUT', `/${id}/dataset/parts/1`, undefined, Buffer.alloc(60))).status, 200);
  assert.equal((await s.call('user-a', 'PUT', `/${id}/dataset/parts/99`, undefined, Buffer.alloc(1))).status, 400);
  assert.equal((await s.call('user-a', 'PUT', `/${id}/dataset/parts/2`, undefined, Buffer.alloc(0))).status, 400);
  assert.equal((await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 2 })).status, 413, 'total 120 > 100');
  assert.equal((await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 1 })).status, 202);
  assert.equal((await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(5))).status, 409, 'already uploaded');
  s.close();
});

test('preview: text limits, only when trained; samples 0-4 only', async () => {
  const s = await boot();
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  assert.equal((await s.call('user-a', 'POST', `/${id}/preview`, { text: 'hello' })).status, 409, 'not trained yet');
  s.f.voices.get(id)!.status = 'ready';
  assert.equal(await (await s.call('user-a', 'POST', `/${id}/preview`, { text: 'hello' })).text(), 'wav:hello');
  assert.equal((await s.call('user-a', 'POST', `/${id}/preview`, { text: 'x'.repeat(301) })).status, 400);
  assert.equal((await s.call('user-a', 'POST', `/${id}/preview`, { text: '   ' })).status, 400);
  assert.equal((await s.call('user-a', 'GET', `/${id}/samples/4`)).status, 200);
  assert.equal((await s.call('user-a', 'GET', `/${id}/samples/5`)).status, 404);
  s.close();
});

test('deploy only when ready, backfills key owners, returns voice name; delete removes', async () => {
  const s = await boot();
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  assert.equal((await s.call('user-a', 'POST', `/${id}/deploy`)).status, 409);
  s.f.voices.get(id)!.status = 'ready';
  s.backfilled.length = 0;
  const r = await s.call('user-a', 'POST', `/${id}/deploy`);
  assert.deepEqual(await r.json(), { id, voice: `custom:${id}` });
  assert.deepEqual(s.backfilled, ['user-a']);
  assert.equal((await s.call('user-a', 'DELETE', `/${id}`)).status, 200);
  assert.equal((await s.call('user-a', 'GET', `/${id}`)).status, 404);
  s.close();
});

test('intake failures do not leak internals', async () => {
  const s = await boot();
  s.f.intake.list = async () => { throw new IntakeError(500, 'Traceback secret path /datasets/x'); };
  const r = await s.call('user-a', 'GET', '/');
  assert.equal(r.status, 502);
  assert.doesNotMatch(await r.text(), /Traceback|datasets/);
  s.close();
});

test('rate limit on creation is per user', async () => {
  const s = await boot({ rateLimits: { create: 2 } });
  assert.equal((await s.call('user-a', 'POST', '/', consent)).status, 201);
  assert.equal((await s.call('user-a', 'POST', '/', consent)).status, 201);
  assert.equal((await s.call('user-a', 'POST', '/', consent)).status, 429);
  assert.equal((await s.call('user-b', 'POST', '/', consent)).status, 201);
  s.close();
});

// --------------------------------------------------------------------------
// Billing gate / charge / usage-report deps (added for the web flow, wired for real in
// routes/voiceStudio.ts via lib/realtimeTtsBilling.ts's isBillingActiveForUser/chargeForVoiceClone/
// reportTtsUsage). These deps are optional so the API-key flow (voiceStudioApiKey.ts), which doesn't
// pass them, keeps its existing meter-but-don't-gate behavior unchanged.
// --------------------------------------------------------------------------

test('billing inactive -> POST / (create) returns 402 in voiceClone.ts\'s exact error shape, intake never called', async () => {
  const s = await boot({ requireActiveBilling: async () => false });
  const r = await s.call('user-a', 'POST', '/', consent);
  assert.equal(r.status, 402);
  assert.deepEqual(await r.json(), { error: 'Voice cloning requires an active TTS subscription.' });
  assert.equal(s.f.calls.includes('create'), false);
  s.close();
});

test('billing inactive -> POST /:id/dataset/commit returns 402, intake.commit never called, no charge', async () => {
  const chargeCalls: string[] = [];
  let billingActive = true;
  const s = await boot({
    requireActiveBilling: async () => billingActive,
    onCommitSuccess: async (userId) => { chargeCalls.push(userId); return true; },
  });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(10));
  billingActive = false;
  const r = await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 1 });
  assert.equal(r.status, 402);
  assert.equal(s.f.calls.includes('commit'), false);
  assert.equal(chargeCalls.length, 0);
  s.close();
});

test('billing active -> create and commit proceed normally, and commit charges via onCommitSuccess', async () => {
  const chargeCalls: Array<{ userId: string; voiceId: string }> = [];
  const s = await boot({
    requireActiveBilling: async () => true,
    onCommitSuccess: async (userId, voiceId) => { chargeCalls.push({ userId, voiceId }); return true; },
  });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(10));
  const r = await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 1 });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 10)); // onCommitSuccess is fire-and-forget after the response
  assert.deepEqual(chargeCalls, [{ userId: 'user-a', voiceId: id }]);
  s.close();
});

test('charge failure (onCommitSuccess resolves false, or throws) does not block or fail the commit response', async () => {
  const s = await boot({
    requireActiveBilling: async () => true,
    onCommitSuccess: async () => { throw new Error('Stripe down'); },
  });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(10));
  const r = await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 1 });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { id, status: 'training', clips: 1 });
  s.close();
});

test('successful preview reports usage via reportTtsUsage with the synthesized character count', async () => {
  const usageCalls: Array<{ userId: string; charCount: number }> = [];
  const s = await boot({ reportTtsUsage: async (userId, charCount) => { usageCalls.push({ userId, charCount }); } });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  s.f.voices.get(id)!.status = 'ready';
  const r = await s.call('user-a', 'POST', `/${id}/preview`, { text: 'hello world' });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 10)); // reportTtsUsage is fire-and-forget after the response
  assert.deepEqual(usageCalls, [{ userId: 'user-a', charCount: 'hello world'.length }]);
  s.close();
});

test('usage-report failure does not block or fail the preview response', async () => {
  const s = await boot({ reportTtsUsage: async () => { throw new Error('Stripe meter event failed'); } });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  s.f.voices.get(id)!.status = 'ready';
  const r = await s.call('user-a', 'POST', `/${id}/preview`, { text: 'hello world' });
  assert.equal(r.status, 200);
  s.close();
});

test('billing inactive -> GET /:id and DELETE /:id still work (status/delete are never gated)', async () => {
  const s = await boot({ requireActiveBilling: async () => true });
  const { id } = (await (await s.call('user-a', 'POST', '/', consent)).json()) as { id: string };
  // Flip billing inactive only after the voice already exists, then confirm status/delete still work.
  const s2 = await boot({ requireActiveBilling: async () => false });
  const { id: id2 } = await (async () => {
    // Recreate under the inactive-billing instance's own intake — creation itself would 402 here, so
    // seed the fake intake directly to isolate what this test is actually checking (status/delete).
    const created = await s2.f.intake.create({ owner_user_id: 'user-a', speaker_name: 'X' });
    return { id: created.voice_id };
  })();
  assert.equal((await s2.call('user-a', 'GET', `/${id2}`)).status, 200);
  assert.equal((await s2.call('user-a', 'DELETE', `/${id2}`)).status, 200);
  s.close();
  s2.close();
});

test('no requireActiveBilling dep (matches the API-key flow) -> create and commit are never gated', async () => {
  const s = await boot(); // requireActiveBilling intentionally omitted
  const created = await s.call('user-a', 'POST', '/', consent);
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  await s.call('user-a', 'PUT', `/${id}/dataset/parts/0`, undefined, Buffer.alloc(10));
  const r = await s.call('user-a', 'POST', `/${id}/dataset/commit`, { parts: 1 });
  assert.equal(r.status, 202);
  s.close();
});
