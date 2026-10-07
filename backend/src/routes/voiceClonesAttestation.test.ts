// Route-level tests for attestation mode and GET /config.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

const modP = import('./voiceClones.js');
const dblP = import('../lib/voiceCloning/testDoubles.js');
const polP = import('../lib/voiceCloning/policy.js');
import type { Eligibility } from '../lib/voiceCloning/types.js';

function resolver(req: Request): Promise<Eligibility | null> {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!t) return Promise.resolve(null);
  const [userId, v, plan] = t.split('|');
  return Promise.resolve({ userId: userId!, emailVerified: v === '1', plan: plan === 'none' ? null : (plan as 'paid' | 'comped') });
}

async function boot(consentRequired: boolean) {
  const [{ createVoiceClonesRouter }, { default: express }, dbl, pol] = await Promise.all([modP, import('express'), dblP, polP]);
  const store = new dbl.MemoryStore();
  const service = new dbl.FakeService();
  const asr = new dbl.FakeAsr();
  let asrCalls = 0;
  const tr = asr.transcribe.bind(asr);
  asr.transcribe = async (...a: Parameters<typeof tr>) => { asrCalls += 1; return tr(...a); };
  const blobs = new dbl.MemoryBlobs();
  const deps = { store, blobs, service, asr, policy: pol.DEFAULT_POLICY, consentRequired: () => consentRequired };
  const app = express();
  app.use('/api/voice-clones', createVoiceClonesRouter({ getDeps: () => deps, resolveEligibility: resolver }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, store, service, blobs, asrCalls: () => asrCalls, close: () => server.close() };
}

const AUTH = { Authorization: 'Bearer user-1|1|paid' };
const wavish = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'audio/wav' });

function form(fields: Record<string, string>, opts: { reference?: boolean; consent?: boolean } = { reference: true }) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  if (opts.reference) f.append('reference', wavish(9000), 'ref.wav');
  if (opts.consent) f.append('consent', wavish(4000), 'consent.wav');
  return f;
}
const post = (base: string, body: FormData, headers: Record<string, string> = AUTH) =>
  fetch(`${base}/api/voice-clones`, { method: 'POST', headers, body });

test('GET /config: auth required, reports consent_required for each mode', async () => {
  for (const mode of [true, false]) {
    const ctx = await boot(mode);
    try {
      assert.equal((await fetch(`${ctx.base}/api/voice-clones/config`)).status, 401);
      const r = await fetch(`${ctx.base}/api/voice-clones/config`, { headers: AUTH });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { consent_required: mode });
    } finally { ctx.close(); }
  }
});

test('attestation mode: consent-challenges is 200 {consent_required:false} and creates no row', async () => {
  const ctx = await boot(false);
  try {
    const r = await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { consent_required: false });
    assert.equal(ctx.store.challenges.size, 0);
  } finally { ctx.close(); }
});

test('strict mode: consent-challenges still issues a challenge (201)', async () => {
  const ctx = await boot(true);
  try {
    const r = await fetch(`${ctx.base}/api/voice-clones/consent-challenges`, { method: 'POST', headers: AUTH });
    assert.equal(r.status, 201);
    const b = await r.json() as Record<string, unknown>;
    assert.ok(b.challenge_id && b.phrase);
  } finally { ctx.close(); }
});

test('attestation mode: name, language, reference, attested=true creates a voice; no ASR/similarity/consent upload', async () => {
  const ctx = await boot(false);
  try {
    const r = await post(ctx.base, form({ name: 'Narrator', language: 'en', attested: 'true' }));
    assert.equal(r.status, 201);
    const b = await r.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(b).sort(), ['created_at', 'id', 'language', 'model', 'name', 'reference_seconds', 'status']);
    assert.equal(ctx.asrCalls(), 0);
    assert.ok(!ctx.service.calls.includes('similarity'));
    assert.equal(ctx.blobs.objects.size, 0);
    assert.equal(ctx.store.voices.size, 1);
    const c = [...ctx.store.consents.values()][0]!;
    assert.equal(c.phrase, 'ATTESTED');
    assert.equal(c.clipPath, '');
  } finally { ctx.close(); }
});

test('attestation mode: missing or non-"true" attested -> 422 attestation_required', async () => {
  const ctx = await boot(false);
  try {
    for (const extra of [{}, { attested: 'false' }, { attested: 'True' }, { attested: '1' }]) {
      const r = await post(ctx.base, form({ name: 'N', language: 'en', ...extra }));
      assert.equal(r.status, 422);
      assert.equal((await r.json() as { code: string }).code, 'attestation_required');
    }
    assert.equal(ctx.store.voices.size, 0);
  } finally { ctx.close(); }
});

test('attestation mode: auth, email, plan, missing reference, daily limit and reference gate still apply', async () => {
  const ctx = await boot(false);
  try {
    const ok = { name: 'N', language: 'en', attested: 'true' };
    assert.equal((await post(ctx.base, form(ok), {})).status, 401);
    const unv = await post(ctx.base, form(ok), { Authorization: 'Bearer u2|0|paid' });
    assert.equal(unv.status, 403);
    assert.equal((await unv.json() as { code: string }).code, 'email_unverified');
    assert.equal((await post(ctx.base, form(ok), { Authorization: 'Bearer u3|1|none' })).status, 402);
    assert.equal((await post(ctx.base, form(ok, {}))).status, 400);
    assert.equal((await post(ctx.base, form({ ...ok, language: 'xx' }))).status, 400);

    ctx.service.analyzeResult = () => ({ durationSec: 2, speechSec: 1, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 });
    const bad = await post(ctx.base, form(ok));
    assert.equal(bad.status, 422);
    assert.equal((await bad.json() as { code: string }).code, 'reference_rejected');
    ctx.service.analyzeResult = () => ({ durationSec: 12, speechSec: 10, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 });

    for (let i = 0; i < 3; i++) assert.equal((await post(ctx.base, form(ok))).status, 201);
    const lim = await post(ctx.base, form(ok));
    assert.equal(lim.status, 429);
    assert.equal((await lim.json() as { code: string }).code, 'daily_limit');
  } finally { ctx.close(); }
});

test('attestation mode: a stray consent file / challenge_id is ignored (not analysed, not stored)', async () => {
  const ctx = await boot(false);
  try {
    const r = await post(ctx.base, form({ name: 'N', language: 'en', attested: 'true', challenge_id: '00000000-0000-4000-8000-000000000000' }, { reference: true, consent: true }));
    assert.equal(r.status, 201);
    assert.equal(ctx.service.calls.filter((c) => c === 'analyze').length, 1);
    assert.equal(ctx.blobs.objects.size, 0);
  } finally { ctx.close(); }
});

test('strict mode: attested=true without a consent file is still 400 audio_required (no bypass)', async () => {
  const ctx = await boot(true);
  try {
    const r = await post(ctx.base, form({ name: 'N', language: 'en', attested: 'true' }));
    assert.equal(r.status, 400);
    assert.equal((await r.json() as { code: string }).code, 'audio_required');
    const r2 = await post(ctx.base, form({ name: 'N', language: 'en', attested: 'true', challenge_id: '00000000-0000-4000-8000-000000000000' }));
    assert.equal(r2.status, 400);
    assert.equal(ctx.store.voices.size, 0);
  } finally { ctx.close(); }
});
