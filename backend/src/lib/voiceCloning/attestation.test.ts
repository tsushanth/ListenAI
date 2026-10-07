// Attestation mode (VOICE_CLONE_REQUIRE_CONSENT_PHRASE="false"): no ASR, no similarity, no consent clip, evidence rows still written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, consentPhraseRequired } from './policy.js';
import {
  ATTESTED, CloneError, createVoiceClone, deleteVoiceClone, purgeExpired, type CloneDeps, type CreateVoiceInput,
} from './service.js';
import { FakeAsr, FakeService, MemoryBlobs, MemoryStore } from './testDoubles.js';
import type { Eligibility } from './types.js';

const paid: Eligibility = { userId: 'u1', emailVerified: true, plan: 'paid' };
const T0 = new Date('2026-10-07T12:00:00Z');

function setup(consentRequired = false) {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const service = new FakeService();
  const asr = new FakeAsr();
  let asrCalls = 0;
  const origTranscribe = asr.transcribe.bind(asr);
  asr.transcribe = async (...a: Parameters<typeof origTranscribe>) => { asrCalls += 1; return origTranscribe(...a); };
  const deps: CloneDeps = { store, blobs, service, asr, policy: DEFAULT_POLICY, now: () => T0, consentRequired: () => consentRequired };
  return { store, blobs, service, asr, deps, asrCalls: () => asrCalls };
}

const att = (over: Partial<CreateVoiceInput> = {}): CreateVoiceInput => ({
  eligibility: paid, name: 'Mine', language: 'en', attested: true,
  reference: { audio: Buffer.from('reference-audio'), mime: 'audio/wav', filename: 'ref.wav' }, ...over,
});

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof CloneError, String(err));
    assert.equal(err.code, code);
    if (status) assert.equal(err.status, status);
    return true;
  });
}

test('flag parsing: only the literal string "false" turns the phrase step off', () => {
  assert.equal(consentPhraseRequired({}), true);
  for (const v of ['', 'true', 'FALSE', 'False', '0', 'no', ' false', 'false ']) {
    assert.equal(consentPhraseRequired({ VOICE_CLONE_REQUIRE_CONSENT_PHRASE: v }), true, JSON.stringify(v));
  }
  assert.equal(consentPhraseRequired({ VOICE_CLONE_REQUIRE_CONSENT_PHRASE: 'false' }), false);
});

test('attestation: creates the voice and writes ATTESTED evidence, with no ASR / similarity / consent clip', async () => {
  const s = setup();
  const r = await createVoiceClone(s.deps, att());
  assert.equal(r.voice.status, 'active');
  assert.ok(s.service.voices.has(r.voice.id));
  assert.equal(s.asrCalls(), 0);
  assert.ok(!s.service.calls.includes('similarity'));
  assert.deepEqual(s.service.calls.filter((c) => c === 'analyze').length, 1, 'only the reference is analysed');
  assert.equal(s.blobs.objects.size, 0);

  const consent = s.store.consents.get(r.voice.consentId)!;
  assert.equal(consent.phrase, ATTESTED);
  assert.equal(consent.transcript, 'ATTESTED');
  assert.equal(consent.phraseWer, 0);
  assert.equal(consent.speakerSimilarity, 0);
  assert.equal(consent.similarityThreshold, 0);
  assert.equal(consent.similarityModel, 'none');
  assert.equal(consent.borderline, false);
  assert.equal(consent.clipPath, '');
  assert.equal(consent.clipSha256, '');
  assert.equal(consent.userId, 'u1');
  assert.equal(consent.retainUntil, undefined, 'retain_until stays NULL while the voice exists');

  const ch = s.store.challenges.get(consent.challengeId)!;
  assert.equal(ch.phrase, 'ATTESTED');
  assert.deepEqual(ch.codeWords, []);
  assert.ok(ch.consumedAt, 'challenge consumed immediately');
  assert.equal(s.store.challenges.size, 1);
});

test('attestation: attested missing/false -> 422 attestation_required, nothing created', async () => {
  const s = setup();
  await rejects(createVoiceClone(s.deps, att({ attested: undefined })), 'attestation_required', 422);
  await rejects(createVoiceClone(s.deps, att({ attested: false })), 'attestation_required', 422);
  assert.equal(s.store.voices.size, 0);
  assert.equal(s.store.consents.size, 0);
  assert.equal(s.service.calls.length, 0);
});

test('attestation: eligibility, language, daily limit and reference gate still apply', async () => {
  const s = setup();
  await rejects(createVoiceClone(s.deps, att({ eligibility: { ...paid, emailVerified: false } })), 'email_unverified', 403);
  await rejects(createVoiceClone(s.deps, att({ eligibility: { ...paid, plan: null } })), 'payment_required', 402);
  await rejects(createVoiceClone(s.deps, att({ language: 'xx' })), 'unsupported_language', 400);

  for (let i = 0; i < DEFAULT_POLICY.dailyLimitPaid; i++) await createVoiceClone(s.deps, att());
  await rejects(createVoiceClone(s.deps, att()), 'daily_limit', 429);
  assert.equal(s.store.voices.size, DEFAULT_POLICY.dailyLimitPaid);

  const g = setup();
  g.service.analyzeResult = () => ({ durationSec: 2, speechSec: 1, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 });
  await assert.rejects(createVoiceClone(g.deps, att()), (err: unknown) => {
    assert.ok(err instanceof CloneError);
    assert.equal(err.code, 'reference_rejected');
    assert.equal(err.status, 422);
    return true;
  });
  assert.equal(g.store.voices.size, 0);
  assert.ok(!g.service.calls.includes('createVoice'));
  assert.equal(g.store.consents.size, 0);
});

test('attestation: persistence failure removes the voice from the serving app', async () => {
  const s = setup();
  s.store.insertVoice = async () => { throw new Error('db down'); };
  await assert.rejects(createVoiceClone(s.deps, att()));
  assert.equal(s.service.voices.size, 0);
});

test('strict mode is unchanged and attested=true does not bypass it', async () => {
  const s = setup(true);
  await rejects(createVoiceClone(s.deps, att()), 'audio_required', 400);
  await rejects(createVoiceClone(s.deps, att({ challengeId: '00000000-0000-4000-8000-000000000000' })), 'audio_required', 400);
  await rejects(createVoiceClone(s.deps, att({ consent: { audio: Buffer.from('c'), mime: 'audio/wav' } })), 'audio_required', 400);
  // with both, the strict checks run (challenge unknown), so attested did not skip anything
  await rejects(createVoiceClone(s.deps, att({ challengeId: '00000000-0000-4000-8000-000000000000', consent: { audio: Buffer.from('c'), mime: 'audio/wav' } })), 'challenge_not_found', 404);
  assert.equal(s.store.voices.size, 0);
  assert.equal(s.service.calls.length, 0);
});

test('deletion and retention sweep work for attestation evidence (no clip to remove)', async () => {
  const s = setup();
  const { voice } = await createVoiceClone(s.deps, att());
  await deleteVoiceClone(s.deps, 'u1', voice.id);
  const later = { store: s.store, blobs: s.blobs, now: () => new Date('2028-01-01T00:00:00Z') };
  const removed: string[][] = [];
  s.blobs.remove = async (p: string[]) => { removed.push(p); };
  const out = await purgeExpired(later);
  assert.equal(out.consents, 1);
  assert.deepEqual(removed, [], 'no storage call for an empty clip path');
});
