import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY } from './policy.js';
import {
  CloneError, assertEligible, createVoiceClone, deleteVoiceClone, disableVoiceClone, getUsableVoice, issueConsentChallenge,
  purgeExpired, recordOutput, type CloneDeps,
} from './service.js';
import { FakeAsr, FakeService, GOOD_METRICS, MemoryBlobs, MemoryStore } from './testDoubles.js';
import type { Eligibility } from './types.js';

const paid: Eligibility = { userId: 'u1', emailVerified: true, plan: 'paid' };
const T0 = new Date('2026-10-06T12:00:00Z');

function setup() {
  const store = new MemoryStore();
  const blobs = new MemoryBlobs();
  const service = new FakeService();
  const asr = new FakeAsr();
  let t = T0.getTime();
  const deps: CloneDeps = { store, blobs, service, asr, policy: DEFAULT_POLICY, now: () => new Date(t) };
  return { store, blobs, service, asr, deps, advance: (ms: number) => { t += ms; } };
}

async function challengeFor(s: ReturnType<typeof setup>, e = paid) {
  const c = await issueConsentChallenge(s.deps, e);
  s.asr.heard = c.phrase; // the speaker reads it correctly
  return c;
}

const body = (challengeId: string, e: Eligibility = paid) => ({
  eligibility: e, name: 'My voice', language: 'en', challengeId,
  consent: { audio: Buffer.from('consent-audio'), mime: 'audio/wav' },
  reference: { audio: Buffer.from('reference-audio'), mime: 'audio/wav', filename: 'ref.wav' },
});

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof CloneError, String(err));
    assert.equal(err.code, code);
    if (status) assert.equal(err.status, status);
    return true;
  });
}

test('eligibility: unverified email and unpaid accounts cannot even get a challenge', async () => {
  const s = setup();
  await rejects(issueConsentChallenge(s.deps, { ...paid, emailVerified: false }), 'email_unverified', 403);
  await rejects(issueConsentChallenge(s.deps, { ...paid, plan: null }), 'payment_required', 402);
  assert.equal(s.store.challenges.size, 0);
  assert.throws(() => assertEligible({ ...paid, plan: null }));
});

test('happy path creates voice, stores consent metadata, consumes the challenge', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const r = await createVoiceClone(s.deps, body(c.challengeId));
  assert.equal(r.voice.status, 'active');
  assert.equal(r.voice.modelId, 'chatterbox-mtl-v3');
  const consent = [...s.store.consents.values()][0]!;
  assert.equal(consent.userId, 'u1');
  assert.equal(consent.phrase, c.phrase);
  assert.equal(consent.speakerSimilarity, 0.72);
  assert.equal(consent.similarityThreshold, 0.4);
  assert.equal(consent.createdAt, T0.toISOString());
  assert.equal(consent.clipSha256.length, 64);
  assert.equal(s.blobs.objects.size, 1);
  assert.ok(s.blobs.objects.has(consent.clipPath));
  assert.equal(r.voice.consentId, consent.id);
  assert.ok(s.store.challenges.get(c.challengeId)!.consumedAt);
  assert.ok(s.service.voices.has(r.voice.id));
});

test('a consumed challenge cannot be replayed', async () => {
  const s = setup();
  const c = await challengeFor(s);
  await createVoiceClone(s.deps, body(c.challengeId));
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'challenge_used', 409);
});

test('an expired challenge is rejected before any GPU call', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.advance(6 * 60 * 1000);
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'challenge_expired', 410);
  assert.deepEqual(s.service.calls, []);
});

test("another user's challenge is not found", async () => {
  const s = setup();
  const c = await challengeFor(s);
  await rejects(createVoiceClone(s.deps, body(c.challengeId, { ...paid, userId: 'u2' })), 'challenge_not_found', 404);
});

test('wrong phrase is rejected, creates nothing, skips similarity, burns an attempt', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.asr.heard = 'completely different words';
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'phrase_mismatch', 422);
  assert.equal(s.store.voices.size, 0);
  assert.equal(s.blobs.objects.size, 0);
  assert.ok(!s.service.calls.includes('similarity'));
  assert.ok(!s.service.calls.includes('createVoice'));
  assert.equal(s.store.challenges.get(c.challengeId)!.attempts, 1);
});

test('speaker mismatch (consent voice is not the reference voice) is rejected', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.service.similarityValue = 0.12;
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'speaker_mismatch', 422);
  assert.equal(s.store.voices.size, 0);
  assert.ok(!s.service.calls.includes('createVoice'));
});

test('after maxConsentAttempts failures the challenge is burned', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.service.similarityValue = 0.1;
  for (let i = 0; i < 3; i++) await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'speaker_mismatch');
  s.service.similarityValue = 0.9;
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'challenge_used', 409);
});

test('ASR outage -> 503, nothing created', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.asr.fail = true;
  await rejects(createVoiceClone(s.deps, body(c.challengeId)), 'asr_unavailable', 503);
  assert.equal(s.store.voices.size, 0);
});

test('reference gate failure is a 422 with reasons and happens before consent is evaluated', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.service.analyzeResult = (_a, f) => (f === 'ref.wav' ? { ...GOOD_METRICS, durationSec: 4, speechSec: 4, musicProb: 0.9 } : GOOD_METRICS);
  await assert.rejects(createVoiceClone(s.deps, body(c.challengeId)), (err: unknown) => {
    assert.ok(err instanceof CloneError);
    assert.equal(err.code, 'reference_rejected');
    const codes = (err.details as { failures: Array<{ code: string }> }).failures.map((f) => f.code);
    assert.ok(codes.includes('too_short') && codes.includes('music_detected'));
    return true;
  });
  assert.equal(s.store.challenges.get(c.challengeId)!.attempts, 0); // a bad recording does not burn a consent attempt
  assert.ok(!s.service.calls.includes('similarity'));
});

test('unsupported language is rejected', async () => {
  const s = setup();
  const c = await challengeFor(s);
  await rejects(createVoiceClone(s.deps, { ...body(c.challengeId), language: 'xx' }), 'unsupported_language', 400);
});

test('daily limit: 3 per 24h for paid, deletions still count, window rolls', async () => {
  const s = setup();
  for (let i = 0; i < 3; i++) {
    const c = await challengeFor(s);
    const r = await createVoiceClone(s.deps, body(c.challengeId));
    if (i === 0) await deleteVoiceClone(s.deps, 'u1', r.voice.id); // delete-and-recreate must not reset the counter
  }
  const c4 = await challengeFor(s);
  await rejects(createVoiceClone(s.deps, body(c4.challengeId)), 'daily_limit', 429);
  s.advance(24 * 3600 * 1000 + 1000);
  const c5 = await issueConsentChallenge(s.deps, paid);
  s.asr.heard = c5.phrase;
  await createVoiceClone(s.deps, body(c5.challengeId));
});

test('daily limit for comped/trial accounts is 10', async () => {
  const s = setup();
  const trial: Eligibility = { userId: 'trial1', emailVerified: true, plan: 'comped' };
  for (let i = 0; i < 10; i++) {
    const c = await challengeFor(s, trial);
    await createVoiceClone(s.deps, body(c.challengeId, trial));
  }
  const c = await challengeFor(s, trial);
  await rejects(createVoiceClone(s.deps, body(c.challengeId, trial)), 'daily_limit', 429);
});

test('concurrent creation by one user is refused', async () => {
  const s = setup();
  const c1 = await challengeFor(s);
  const c2 = await challengeFor(s);
  const slow = s.service.createVoice.bind(s.service);
  s.service.createVoice = async (p) => { await new Promise((r) => setTimeout(r, 20)); return slow(p); };
  s.asr.heardFor = (audio) => (audio.toString() === 'consent-1' ? c1.phrase : c2.phrase);
  const withAudio = (id: string, tag: string) => ({ ...body(id), consent: { audio: Buffer.from(tag), mime: 'audio/wav' } });
  const results = await Promise.allSettled([createVoiceClone(s.deps, withAudio(c1.challengeId, 'consent-1')), createVoiceClone(s.deps, withAudio(c2.challengeId, 'consent-2'))]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rej.reason as CloneError).code, 'creation_in_progress');
});

test('if persisting fails after the serving app created the voice, the voice is removed again', async () => {
  const s = setup();
  const c = await challengeFor(s);
  s.store.insertVoice = async () => { throw new Error('db down'); };
  await assert.rejects(createVoiceClone(s.deps, body(c.challengeId)), /db down/);
  assert.equal(s.service.voices.size, 0);
});

test('getUsableVoice enforces ownership, status and continued eligibility', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  assert.equal((await getUsableVoice(s.store, voice.id, paid)).id, voice.id);
  await rejects(getUsableVoice(s.store, voice.id, { ...paid, userId: 'other' }), 'voice_not_found', 404);
  await rejects(getUsableVoice(s.store, voice.id, { ...paid, plan: null }), 'payment_required', 402);
  await disableVoiceClone(s.deps, voice.id, 'impersonation');
  await rejects(getUsableVoice(s.store, voice.id, paid), 'voice_disabled', 403);
});

test('deletion removes serving-side audio, marks deleted, schedules consent retention (12 months)', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  const r = await deleteVoiceClone(s.deps, 'u1', voice.id);
  assert.equal(r.deleted, true);
  assert.ok(!s.service.voices.has(voice.id));
  assert.equal(s.store.voices.get(voice.id)!.status, 'deleted');
  assert.equal(s.store.consents.get(voice.consentId)!.retainUntil, '2027-10-06T12:00:00.000Z');
  await rejects(getUsableVoice(s.store, voice.id, paid), 'voice_not_found');
  assert.equal((await deleteVoiceClone(s.deps, 'u1', voice.id)).alreadyDeleted, true);
});

test('deletion: if the serving app does not confirm, the voice stays unusable (deleting) and the call is retryable', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  s.service.failDelete = true;
  await rejects(deleteVoiceClone(s.deps, 'u1', voice.id), 'deletion_pending', 502);
  assert.equal(s.store.voices.get(voice.id)!.status, 'deleting');
  await rejects(getUsableVoice(s.store, voice.id, paid), 'voice_unavailable', 409);
  s.service.failDelete = false;
  assert.equal((await deleteVoiceClone(s.deps, 'u1', voice.id)).deleted, true);
});

test('deletion refuses another user\'s voice', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  await rejects(deleteVoiceClone(s.deps, 'intruder', voice.id), 'voice_not_found', 404);
});

test('takedown disables the voice on both sides, purges outputs, keeps consent evidence', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  const r = await disableVoiceClone(s.deps, voice.id, 'credible impersonation claim');
  assert.equal(r.outputsPurged, 2);
  assert.equal(s.store.voices.get(voice.id)!.status, 'disabled');
  assert.equal(s.store.voices.get(voice.id)!.disabledReason, 'credible impersonation claim');
  assert.ok(s.service.disabled.has(voice.id));
  assert.ok(s.store.consents.has(voice.consentId));
  assert.deepEqual(s.store.purgedOutputsFor, [voice.id]);
});

test('takedown still disables locally when the serving app is unreachable, and says so', async () => {
  const s = setup();
  const c = await challengeFor(s);
  const { voice } = await createVoiceClone(s.deps, body(c.challengeId));
  s.service.failDisable = true;
  const r = await disableVoiceClone(s.deps, voice.id, 'x');
  assert.equal(r.serviceDisabled, false);
  assert.equal(s.store.voices.get(voice.id)!.status, 'disabled');
});

test('output hash is recorded with watermark metadata and a 90 day expiry, then purged', async () => {
  const s = setup();
  const audio = Buffer.from('some wav bytes');
  const rec = await recordOutput(s.deps, { voiceId: 'v', userId: 'u1', audio, chars: 120, synth: { watermarkScheme: 'perth', watermarkScore: 0.98 } });
  assert.equal(rec.sha256, (await import('node:crypto')).createHash('sha256').update(audio).digest('hex'));
  assert.equal(rec.watermarkScheme, 'perth');
  assert.equal(rec.expiresAt, '2027-01-04T12:00:00.000Z');
  assert.equal(await purgeExpired({ store: s.store, now: () => new Date('2027-01-05T00:00:00Z') }), 1);
  assert.equal(s.store.outputs.length, 0);
});
