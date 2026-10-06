import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, loadClonePolicy } from './policy.js';
import { evaluateConsentClip, evaluateReference } from './referenceGate.js';
import { evaluateConsent } from './consent.js';
import type { AudioMetrics, AsrClient } from './types.js';

const good: AudioMetrics = { durationSec: 12, speechSec: 10, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 };
const P = DEFAULT_POLICY;

test('loadClonePolicy: defaults, env override, junk ignored', () => {
  assert.deepEqual(loadClonePolicy({}), P);
  const p = loadClonePolicy({ VOICE_CLONE_SIMILARITY_THRESHOLD: '0.55', VOICE_CLONE_DAILY_LIMIT: '5', VOICE_CLONE_MIN_SNR_DB: 'abc', VOICE_CLONE_MAX_MUSIC_PROB: '-1' });
  assert.equal(p.similarityThreshold, 0.55);
  assert.equal(p.dailyLimitPaid, 5);
  assert.equal(p.minSnrDb, P.minSnrDb);
  assert.equal(p.maxMusicProb, P.maxMusicProb);
});

test('default policy matches the safeguards spec', () => {
  assert.equal(P.minReferenceSec, 8);
  assert.equal(P.dailyLimitPaid, 3);
  assert.equal(P.dailyLimitTrial, 10);
  assert.equal(P.outputHashRetentionDays, 90);
  assert.equal(P.consentRetentionMonthsAfterDelete, 12);
  // threshold sits between the REPORT's different-speaker p95 (0.38) and same-speaker p05 (0.43)
  assert.ok(P.similarityThreshold > 0.38 && P.similarityThreshold < 0.43);
});

test('reference gate passes a clean clip', () => {
  assert.deepEqual(evaluateReference(good, P), { ok: true, failures: [] });
});

for (const [name, patch, code] of [
  ['short', { durationSec: 5, speechSec: 5 }, 'too_short'],
  ['long', { durationSec: 500, speechSec: 480 }, 'too_long'],
  ['mostly silence', { speechSec: 3 }, 'not_enough_speech'],
  ['noisy', { snrDb: 9 }, 'too_noisy'],
  ['clipped', { clippingRatio: 0.2 }, 'clipped'],
  ['two speakers', { minWindowSimilarity: 0.1 }, 'multiple_speakers'],
  ['music', { musicProb: 0.9 }, 'music_detected'],
] as const) {
  test(`reference gate rejects: ${name}`, () => {
    const r = evaluateReference({ ...good, ...patch }, P);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.code === code), JSON.stringify(r));
  });
}

test('reference gate: null window similarity (short clip) does not trip the speaker check', () => {
  assert.equal(evaluateReference({ ...good, minWindowSimilarity: null }, P).ok, true);
});

test('consent clip gate: only length and music', () => {
  assert.equal(evaluateConsentClip({ ...good, durationSec: 8, snrDb: 3 }, P).ok, true);
  assert.equal(evaluateConsentClip({ ...good, durationSec: 1 }, P).ok, false);
  assert.equal(evaluateConsentClip({ ...good, musicProb: 0.99 }, P).ok, false);
});

const phrase = 'I agree that ReadAloud may create a synthetic copy of my voice. My code words are maple, tiger, ocean, cedar.';
const codeWords = ['maple', 'tiger', 'ocean', 'cedar'];
const inp = { phrase, codeWords, consentAudio: Buffer.from('c'), consentMime: 'audio/wav', referenceAudio: Buffer.from('r') };
const asrReturning = (t: string): AsrClient => ({ transcribe: async () => t });
const simReturning = (s: number) => ({ similarity: async () => s });

test('consent: matching phrase and similar speaker passes', async () => {
  const r = await evaluateConsent(inp, { asr: asrReturning(phrase), service: simReturning(0.72), policy: P });
  assert.equal(r.ok, true);
  assert.equal(r.speakerSimilarity, 0.72);
  assert.equal(r.borderline, false);
});

test('consent: score just above threshold is accepted but flagged borderline', async () => {
  const r = await evaluateConsent(inp, { asr: asrReturning(phrase), service: simReturning(0.45), policy: P });
  assert.equal(r.ok, true);
  assert.equal(r.borderline, true);
});

test('consent: wrong phrase fails before the (paid) similarity call', async () => {
  let called = false;
  const r = await evaluateConsent(inp, { asr: asrReturning('hello there general kenobi'), service: { similarity: async () => { called = true; return 0.9; } }, policy: P });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'phrase_mismatch');
  assert.equal(called, false);
});

test('consent: right words but missing a code word fails', async () => {
  const r = await evaluateConsent(inp, { asr: asrReturning(phrase.replace('cedar', '')), service: simReturning(0.9), policy: P });
  assert.equal(r.failure, 'phrase_mismatch');
});

test('consent: a different speaker (below threshold) is rejected', async () => {
  const r = await evaluateConsent(inp, { asr: asrReturning(phrase), service: simReturning(0.2), policy: P });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'speaker_mismatch');
  assert.equal(r.speakerSimilarity, 0.2);
});

test('consent: threshold is configurable', async () => {
  const strict = { ...P, similarityThreshold: 0.8 };
  assert.equal((await evaluateConsent(inp, { asr: asrReturning(phrase), service: simReturning(0.72), policy: strict })).ok, false);
});

test('consent: NaN similarity fails closed', async () => {
  const r = await evaluateConsent(inp, { asr: asrReturning(phrase), service: simReturning(NaN), policy: P });
  assert.equal(r.ok, false);
});

test('consent: ASR outage fails closed with its own code', async () => {
  const r = await evaluateConsent(inp, { asr: { transcribe: async () => { throw new Error('down'); } }, service: simReturning(0.9), policy: P });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'asr_unavailable');
});
