// npm test (node:test via tsx). Route-level tests for the API-key front door of consent-gated voice cloning,
// wired the way voiceCloneApiKey.ts wires it in production: identity comes from gateway-forwarded headers (a shared
// secret plus x-gateway-uid / x-gateway-key-id), the real createVoiceClonesRouter runs underneath, and Supabase /
// Modal / ASR are in-memory doubles. Real express + real multipart over loopback; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env.SUPABASE_URL ??= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test';
process.env.SUPABASE_JWT_SECRET ??= 'test';
process.env.NODE_ENV = 'test';

import type { BillingPlan } from '../lib/voiceCloning/types.js';
import type { CloneDeps } from '../lib/voiceCloning/service.js';

const SECRET = 'test-forward-secret';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U_UNVERIFIED = '33333333-3333-4333-8333-333333333333';
const U_FREE = '44444444-4444-4444-8444-444444444444';
const U_GONE = '55555555-5555-4555-8555-555555555555';
const U_DOWN = '66666666-6666-4666-8666-666666666666';

const users: Record<string, { emailVerified: boolean; plan: BillingPlan | null }> = {
  [U1]: { emailVerified: true, plan: 'paid' },
  [U2]: { emailVerified: true, plan: 'paid' },
  [U_UNVERIFIED]: { emailVerified: false, plan: 'paid' },
  [U_FREE]: { emailVerified: true, plan: null },
};

async function boot(opts: { dark?: boolean; disabled?: boolean; consentRequired?: boolean; rateLimits?: { create?: number; speech?: number }; policy?: Record<string, number> } = {}) {
  const [{ createVoiceCloneApiRouter }, { default: express }, dbl, pol] = await Promise.all([
    import('./voiceCloneApiKey.js'), import('express'), import('../lib/voiceCloning/testDoubles.js'), import('../lib/voiceCloning/policy.js'),
  ]);
  const store = new dbl.MemoryStore();
  const service = new dbl.FakeService();
  const asr = new dbl.FakeAsr();
  const blobs = new dbl.MemoryBlobs();
  const deps: CloneDeps = { store, blobs, service, asr, policy: { ...pol.DEFAULT_POLICY, ...opts.policy }, consentRequired: () => opts.consentRequired ?? true };
  const router = createVoiceCloneApiRouter({
    getDeps: () => (opts.dark ? null : deps),
    identity: {
      forwardSecret: () => SECRET,
      getUser: async (uid) => {
        if (uid === U_DOWN) throw new Error('supabase down');
        const u = users[uid];
        return u ? { emailVerified: u.emailVerified } : null;
      },
      planFor: async (uid) => users[uid]?.plan ?? null,
    },
    disabled: () => !!opts.disabled,
    rateLimits: opts.rateLimits,
  });
  const app = express();
  app.use('/internal/voice-clone-api', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/voice-clone-api`;
  return { base, store, service, asr, blobs, close: () => server.close() };
}
type Ctx = Awaited<ReturnType<typeof boot>>;

const as = (uid: string): Record<string, string> => ({ 'x-gateway-admin-secret': SECRET, 'x-gateway-uid': uid });
const wavish = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'audio/wav' });

async function issuePhrase(ctx: Ctx, h: Record<string, string>) {
  const r = await fetch(`${ctx.base}/consent-phrase`, { method: 'POST', headers: h });
  return { status: r.status, body: (await r.json()) as { challenge_id: string; phrase: string; expires_at: string } };
}

async function create(ctx: Ctx, h: Record<string, string>, o: { challengeId?: string; consent?: boolean; attested?: string } = {}) {
  const form = new FormData();
  if (o.challengeId) form.append('challenge_id', o.challengeId);
  form.append('name', 'Narrator');
  form.append('language', 'en');
  if (o.consent !== false) form.append('consent', wavish(4000), 'consent.wav');
  form.append('reference', wavish(9000), 'ref.wav');
  if (o.attested) form.append('attested', o.attested);
  return fetch(`${ctx.base}`, { method: 'POST', headers: h, body: form });
}

async function strictCreate(ctx: Ctx, h: Record<string, string>) {
  const ch = await issuePhrase(ctx, h);
  ctx.asr.heard = ch.body.phrase;
  return create(ctx, h, { challengeId: ch.body.challenge_id });
}

const code = async (r: Response) => ((await r.json()) as { code?: string }).code;

test('auth: wrong or missing forward secret is 401 even with a valid uid; unknown uid 401; bare key 403 account_required; lookup outage 503', async () => {
  const ctx = await boot();
  try {
    assert.equal((await fetch(`${ctx.base}/`, { headers: { 'x-gateway-uid': U1 } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/`, { headers: { 'x-gateway-admin-secret': 'nope', 'x-gateway-uid': U1 } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/`, { headers: { 'x-gateway-admin-secret': SECRET } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/`, { headers: as(U_GONE) })).status, 401);
    const bare = await fetch(`${ctx.base}/consent-phrase`, { method: 'POST', headers: { 'x-gateway-admin-secret': SECRET, 'x-gateway-key-id': 'abcd1234abcd1234' } });
    assert.equal(bare.status, 403);
    assert.equal(await code(bare), 'account_required');
    // A forwarded "uid" that is not a UUID (e.g. a key-id smuggled into the uid header) is treated as no account.
    const fake = await fetch(`${ctx.base}/`, { headers: { 'x-gateway-admin-secret': SECRET, 'x-gateway-uid': 'abcd1234abcd1234' } });
    assert.equal(fake.status, 403);
    const down = await fetch(`${ctx.base}/`, { headers: as(U_DOWN) });
    assert.equal(down.status, 503);
    assert.equal(await code(down), 'service_unavailable');
  } finally { ctx.close(); }
});

test('dark deployment and the operator kill switch answer 503 unavailable for every route', async () => {
  for (const o of [{ dark: true }, { disabled: true }]) {
    const ctx = await boot(o);
    try {
      for (const [m, p] of [['POST', '/consent-phrase'], ['GET', '/'], ['GET', '/config'], ['DELETE', `/${U1}`], ['POST', `/${U1}/speech`]] as const) {
        const r = await fetch(`${ctx.base}${p}`, { method: m, headers: as(U1) });
        assert.equal(r.status, 503, `${m} ${p}`);
        assert.equal(await code(r), 'unavailable');
      }
    } finally { ctx.close(); }
  }
});

test('plan gate: free account (no paid or complimentary plan) is 402 payment_required on phrase, create and speech; unverified email is 403', async () => {
  const ctx = await boot();
  try {
    const p = await fetch(`${ctx.base}/consent-phrase`, { method: 'POST', headers: as(U_FREE) });
    assert.equal(p.status, 402);
    assert.equal(await code(p), 'payment_required');
    const c = await create(ctx, as(U_FREE), { challengeId: U1 });
    assert.equal(c.status, 402);
    assert.equal(ctx.service.calls.length, 0, 'the serving app is never called for an ineligible account');
    const s = await fetch(`${ctx.base}/${U1}/speech`, { method: 'POST', headers: { ...as(U_FREE), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal(s.status, 402);
    const u = await fetch(`${ctx.base}/consent-phrase`, { method: 'POST', headers: as(U_UNVERIFIED) });
    assert.equal(u.status, 403);
    assert.equal(await code(u), 'email_unverified');
  } finally { ctx.close(); }
});

test('strict flow: consent-phrase -> create -> list -> speech -> delete; responses carry no audio or consent data', async () => {
  const ctx = await boot();
  try {
    const ph = await issuePhrase(ctx, as(U1));
    assert.equal(ph.status, 201);
    assert.match(ph.body.phrase, /My code words are \w+, \w+, \w+, \w+\.$/);
    assert.ok(new Date(ph.body.expires_at).getTime() > Date.now());
    assert.deepEqual(Object.keys(ph.body).sort(), ['challenge_id', 'expires_at', 'phrase']);

    ctx.asr.heard = ph.body.phrase;
    const created = await create(ctx, as(U1), { challengeId: ph.body.challenge_id });
    assert.equal(created.status, 201);
    const v = (await created.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(v).sort(), ['created_at', 'id', 'language', 'model', 'name', 'reference_seconds', 'status']);
    assert.equal(v.status, 'active');
    assert.ok(ctx.service.calls.includes('similarity'), 'speaker similarity ran');
    assert.equal(ctx.store.voices.get(v.id as string)!.userId, U1, 'voice is bound to the account behind the key');
    assert.equal([...ctx.blobs.objects.keys()].length, 1, 'consent clip stored as evidence');

    const list = (await (await fetch(`${ctx.base}/`, { headers: as(U1) })).json()) as { voices: Array<{ id: string }> };
    assert.deepEqual(list.voices.map((x) => x.id), [v.id]);

    const sp = await fetch(`${ctx.base}/${v.id}/speech`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hello there', speed: 1.1 }) });
    assert.equal(sp.status, 200);
    assert.equal(sp.headers.get('content-type'), 'audio/wav');
    assert.equal(sp.headers.get('x-watermark'), 'perth');
    assert.equal(sp.headers.get('x-voice-id'), v.id);
    assert.equal(ctx.store.outputs.length, 1, 'output hash retained like /api/tts/cloned');

    const del = await fetch(`${ctx.base}/${v.id}`, { method: 'DELETE', headers: as(U1) });
    assert.equal(del.status, 200);
    assert.ok(!ctx.service.voices.has(v.id as string), 'reference audio and embeddings removed from the serving app');
    assert.equal(ctx.store.voices.get(v.id as string)!.status, 'deleted');
    assert.ok(ctx.store.consents.get(ctx.store.voices.get(v.id as string)!.consentId)!.retainUntil, 'consent evidence follows the retention rule (deletion + 12 months)');
    const after = await fetch(`${ctx.base}/${v.id}/speech`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(after.status, 404, 'a deleted voice is unusable');
  } finally { ctx.close(); }
});

test('the alias and the original consent route both issue phrases; the hidden original stays reachable only behind auth', async () => {
  const ctx = await boot();
  try {
    assert.equal((await fetch(`${ctx.base}/consent-challenges`, { method: 'POST', headers: as(U1) })).status, 201);
    assert.equal((await fetch(`${ctx.base}/consent-challenges`, { method: 'POST' })).status, 401);
  } finally { ctx.close(); }
});

test('ownership: another account cannot list, use or delete a cloned voice (always 404, never 403)', async () => {
  const ctx = await boot();
  try {
    const v = (await (await strictCreate(ctx, as(U1))).json()) as { id: string };
    const list = (await (await fetch(`${ctx.base}/`, { headers: as(U2) })).json()) as { voices: unknown[] };
    assert.equal(list.voices.length, 0);
    const sp = await fetch(`${ctx.base}/${v.id}/speech`, { method: 'POST', headers: { ...as(U2), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'steal' }) });
    assert.equal(sp.status, 404);
    assert.equal(await code(sp), 'voice_not_found');
    assert.equal(ctx.service.calls.filter((c) => c === 'synthesize').length, 0, 'no synthesis happened for the intruder');
    const del = await fetch(`${ctx.base}/${v.id}`, { method: 'DELETE', headers: as(U2) });
    assert.equal(del.status, 404);
    assert.ok(ctx.service.voices.has(v.id), 'the owner voice survived the intruder delete');
    assert.equal(ctx.store.voices.get(v.id)!.status, 'active');
    // Malformed ids never reach the store.
    assert.equal((await fetch(`${ctx.base}/not-a-uuid`, { method: 'DELETE', headers: as(U1) })).status, 400);
    assert.equal((await fetch(`${ctx.base}/not-a-uuid/speech`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })).status, 400);
  } finally { ctx.close(); }
});

test('consent failure: wrong phrase -> 422 phrase_mismatch, wrong speaker -> 422 speaker_mismatch, ASR down -> 503 asr_unavailable; nothing is created', async () => {
  const ctx = await boot();
  try {
    const ph = await issuePhrase(ctx, as(U1));
    ctx.asr.heard = 'I like turtles';
    const a = await create(ctx, as(U1), { challengeId: ph.body.challenge_id });
    assert.equal(a.status, 422);
    const ab = (await a.json()) as { code: string; details: { attemptsLeft: number } };
    assert.equal(ab.code, 'phrase_mismatch');
    assert.equal(ab.details.attemptsLeft, 2);
    assert.ok(!ctx.service.calls.includes('similarity'), 'a wrong phrase skips the paid similarity call');

    ctx.asr.heard = ph.body.phrase;
    ctx.service.similarityValue = 0.05;
    const b = await create(ctx, as(U1), { challengeId: ph.body.challenge_id });
    assert.equal(b.status, 422);
    assert.equal(await code(b), 'speaker_mismatch');

    ctx.asr.fail = true;
    const c = await create(ctx, as(U1), { challengeId: ph.body.challenge_id });
    assert.equal(c.status, 503);
    assert.equal(await code(c), 'asr_unavailable');

    assert.equal(ctx.store.voices.size, 0);
    assert.ok(!ctx.service.calls.includes('createVoice'), 'no voice was ever created on the serving app');
    assert.equal(ctx.blobs.objects.size, 0);
  } finally { ctx.close(); }
});

test('consent failure: missing consent recording is 400 audio_required (a reference alone never clones); another account cannot use my phrase', async () => {
  const ctx = await boot();
  try {
    const ph = await issuePhrase(ctx, as(U1));
    const noConsent = await create(ctx, as(U1), { challengeId: ph.body.challenge_id, consent: false });
    assert.equal(noConsent.status, 400);
    assert.equal(await code(noConsent), 'audio_required');
    // attested=true bypasses nothing in strict mode.
    const sneaky = await create(ctx, as(U1), { challengeId: ph.body.challenge_id, consent: false, attested: 'true' });
    assert.equal(sneaky.status, 400);
    // Someone else's challenge id is "not found" for me.
    ctx.asr.heard = ph.body.phrase;
    const stolen = await create(ctx, as(U2), { challengeId: ph.body.challenge_id });
    assert.equal(stolen.status, 404);
    assert.equal(await code(stolen), 'challenge_not_found');
    assert.equal(ctx.store.voices.size, 0);
  } finally { ctx.close(); }
});

test('an expired or already-used phrase is rejected (single use)', async () => {
  const ctx = await boot();
  try {
    const first = await strictCreate(ctx, as(U1));
    assert.equal(first.status, 201);
    const [ch] = [...ctx.store.challenges.values()];
    const reuse = await create(ctx, as(U1), { challengeId: ch!.id });
    assert.equal(reuse.status, 409);
    assert.equal(await code(reuse), 'challenge_used');
    const ph = await issuePhrase(ctx, as(U1));
    ctx.store.challenges.get(ph.body.challenge_id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    ctx.asr.heard = ph.body.phrase;
    const late = await create(ctx, as(U1), { challengeId: ph.body.challenge_id });
    assert.equal(late.status, 410);
    assert.equal(await code(late), 'challenge_expired');
  } finally { ctx.close(); }
});

test('flag VOICE_CLONE_REQUIRE_CONSENT_PHRASE=false (attestation mode): no phrase is issued, attested=true is required, no ASR or similarity runs, evidence is marked ATTESTED', async () => {
  const ctx = await boot({ consentRequired: false });
  try {
    const cfg = await (await fetch(`${ctx.base}/config`, { headers: as(U1) })).json();
    assert.deepEqual(cfg, { consent_required: false });
    const ph = await fetch(`${ctx.base}/consent-phrase`, { method: 'POST', headers: as(U1) });
    assert.equal(ph.status, 200);
    assert.deepEqual(await ph.json(), { consent_required: false });
    assert.equal(ctx.store.challenges.size, 0);

    const missing = await create(ctx, as(U1), { consent: false });
    assert.equal(missing.status, 422);
    assert.equal(await code(missing), 'attestation_required');
    assert.equal(ctx.store.voices.size, 0);

    // A consent file sent anyway is ignored: not analysed, not stored.
    const ok = await create(ctx, as(U1), { attested: 'true' });
    assert.equal(ok.status, 201);
    assert.ok(!ctx.service.calls.includes('similarity'));
    assert.equal(ctx.asr.heard, null);
    assert.equal(ctx.blobs.objects.size, 0);
    const consent = [...ctx.store.consents.values()][0]!;
    assert.equal(consent.phrase, 'ATTESTED');
    assert.equal(consent.similarityModel, 'none');
    assert.equal(consent.userId, U1);
  } finally { ctx.close(); }
});

test('attestation mode keeps the plan gate, the daily limit and the quality gate', async () => {
  const ctx = await boot({ consentRequired: false, policy: { dailyLimitPaid: 1 } });
  try {
    assert.equal((await create(ctx, as(U_FREE), { attested: 'true' })).status, 402);
    ctx.service.analyzeResult = () => ({ durationSec: 2, speechSec: 1, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 });
    const bad = await create(ctx, as(U1), { attested: 'true' });
    assert.equal(bad.status, 422);
    assert.equal(await code(bad), 'reference_rejected');
    ctx.service.analyzeResult = () => ({ durationSec: 12, speechSec: 10, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 });
    assert.equal((await create(ctx, as(U1), { attested: 'true' })).status, 201);
    const limited = await create(ctx, as(U1), { attested: 'true' });
    assert.equal(limited.status, 429);
    assert.equal(await code(limited), 'daily_limit');
  } finally { ctx.close(); }
});

test('daily limit still applies through the API and counts deleted voices', async () => {
  const ctx = await boot({ policy: { dailyLimitPaid: 1 } });
  try {
    const v = (await (await strictCreate(ctx, as(U1))).json()) as { id: string };
    await fetch(`${ctx.base}/${v.id}`, { method: 'DELETE', headers: as(U1) });
    const again = await strictCreate(ctx, as(U1));
    assert.equal(again.status, 429);
    assert.equal(await code(again), 'daily_limit');
  } finally { ctx.close(); }
});

test('rate limit: creation is capped per account per hour (429 rate_limited), other accounts are unaffected', async () => {
  const ctx = await boot({ rateLimits: { create: 2 } });
  try {
    ctx.service.similarityValue = 0.05; // every attempt fails fast; failed attempts must count too
    assert.equal((await strictCreate(ctx, as(U1))).status, 422);
    assert.equal((await strictCreate(ctx, as(U1))).status, 422);
    const third = await strictCreate(ctx, as(U1));
    assert.equal(third.status, 429);
    assert.equal(await code(third), 'rate_limited');
    assert.equal((await strictCreate(ctx, as(U2))).status, 422, 'a different account has its own budget');
  } finally { ctx.close(); }
});

test('rate limit: speech is capped per account per hour', async () => {
  const ctx = await boot({ rateLimits: { speech: 2 } });
  try {
    const v = (await (await strictCreate(ctx, as(U1))).json()) as { id: string };
    const speak = () => fetch(`${ctx.base}/${v.id}/speech`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    assert.equal((await speak()).status, 200);
    assert.equal((await speak()).status, 200);
    const third = await speak();
    assert.equal(third.status, 429);
    assert.equal(await code(third), 'rate_limited');
  } finally { ctx.close(); }
});

test('speech validation: empty text, too long, bad speed are 400; a cancelled plan stops synthesis (402)', async () => {
  const ctx = await boot();
  try {
    const v = (await (await strictCreate(ctx, as(U1))).json()) as { id: string };
    const post = (body: unknown) => fetch(`${ctx.base}/${v.id}/speech`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ text: '' })).status, 400);
    assert.equal((await post({ text: 'x'.repeat(1501) })).status, 400);
    assert.equal((await post({ text: 'ok', speed: 9 })).status, 400);
    assert.equal((await post({ nothing: true })).status, 400);
    users[U1]!.plan = null;
    try { assert.equal((await post({ text: 'ok' })).status, 402); } finally { users[U1]!.plan = 'paid'; }
  } finally { ctx.close(); }
});

test('there is no endpoint that takes a third-party audio URL or voice_url: unknown fields are ignored and never fetched', async () => {
  const ctx = await boot();
  try {
    const ph = await issuePhrase(ctx, as(U1));
    ctx.asr.heard = ph.body.phrase;
    const form = new FormData();
    form.append('challenge_id', ph.body.challenge_id);
    form.append('reference_url', 'http://169.254.169.254/latest/meta-data');
    form.append('voice_url', 'http://169.254.169.254/latest/meta-data');
    const r = await fetch(`${ctx.base}`, { method: 'POST', headers: as(U1), body: form });
    assert.equal(r.status, 400);
    assert.equal(await code(r), 'audio_required');
  } finally { ctx.close(); }
});

test('the abuse-report intake is not exposed on the API-key surface', async () => {
  const ctx = await boot();
  try {
    const r = await fetch(`${ctx.base}/abuse-reports`, { method: 'POST', headers: { ...as(U1), 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual(r.status, 202);
  } finally { ctx.close(); }
});
