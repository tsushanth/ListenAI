import { test } from 'node:test'
import assert from 'node:assert/strict'

const m = await import('../src/lib/voiceCloneErrors.ts')

test('every documented backend code maps to a titled message with a recovery', () => {
  const codes = ['unauthenticated', 'email_unverified', 'payment_required', 'daily_limit', 'creation_in_progress', 'rate_limited', 'unavailable',
    'service_unavailable', 'asr_unavailable', 'attestation_required', 'challenge_expired', 'challenge_used', 'challenge_not_found', 'challenge_attempts_exhausted',
    'phrase_mismatch', 'speaker_mismatch', 'reference_rejected', 'consent_clip_rejected', 'audio_required', 'upload_error', 'unsupported_language',
    'validation', 'deletion_pending', 'voice_not_found', 'voice_disabled', 'voice_unavailable', 'internal']
  for (const code of codes) {
    const e = m.mapCloneError(400, { code, error: 'server text here' })
    assert.equal(e.code, code)
    assert.ok(e.title.length > 3 && e.message.length > 10, code)
    assert.notEqual(e.title, 'Request failed', code)
  }
})

test('reference_rejected lists advice per failure', () => {
  const e = m.mapCloneError(422, { code: 'reference_rejected', details: { failures: [{ code: 'too_noisy', message: 'x' }, { code: 'clipped' }, { code: 'multiple_speakers' }, { code: 'music_detected' }, { code: 'not_enough_speech' }, { code: 'too_short' }, { code: 'too_long' }] } })
  assert.equal(e.recovery, 'fix_reference')
  assert.equal(e.failures?.length, 7)
  assert.match(e.failures![0].advice, /quieter room/)
  for (const f of e.failures!) assert.ok(!f.advice.startsWith('The recording was rejected'), f.code)
})

test('speaker/phrase mismatch keep the challenge while attempts remain, and demand a new one at zero', () => {
  for (const code of ['phrase_mismatch', 'speaker_mismatch']) {
    const some = m.mapCloneError(422, { code, details: { attemptsLeft: 2 } })
    assert.equal(some.recovery, 'rerecord_consent'); assert.equal(some.attemptsLeft, 2); assert.match(some.message, /Attempts left on this phrase: 2/); assert.match(some.message, /reference recording is kept/)
    const none = m.mapCloneError(422, { code, details: { attemptsLeft: 0 } })
    assert.equal(none.recovery, 'new_challenge')
  }
})

test('challenge errors request a new phrase and keep the reference', () => {
  for (const code of ['challenge_expired', 'challenge_used', 'challenge_not_found', 'challenge_attempts_exhausted']) {
    const e = m.mapCloneError(410, { code }); assert.equal(e.recovery, 'new_challenge'); assert.match(e.message, /reference recording is kept/)
  }
})

test('payment_required and email_unverified texts', () => {
  assert.match(m.mapCloneError(402, { code: 'payment_required' }).message, /paid or comped/)
  assert.match(m.mapCloneError(403, { code: 'email_unverified' }).message, /verified email/)
  assert.match(m.mapCloneError(429, { code: 'daily_limit', details: { limit: 3, used: 3 } }).message, /3 new voices per 24 hours/)
})

test('errorHandler shape ({error: CODE, message}) used by /api/tts/cloned is understood', () => {
  const e = m.mapCloneError(503, { error: 'CLONING_UNAVAILABLE', message: 'Voice cloning is not available.' })
  assert.equal(e.code, 'CLONING_UNAVAILABLE')
  const g = m.mapCloneError(402, { error: 'PAYMENT_REQUIRED', message: 'Subscribe first' })
  assert.equal(g.message, 'Subscribe first')
})

test('401 without body and network failure', () => {
  assert.equal(m.mapCloneError(401, null).recovery, 'sign_in')
  assert.equal(m.mapCloneError(0, null).recovery, 'retry')
  assert.equal(m.mapCloneError(500, null).title, 'Request failed')
})

test('duration limits: reference 8-120 s, consent 3-40 s', () => {
  const r = (s: number) => m.checkDuration(s, m.LIMITS.referenceMinSec, m.LIMITS.referenceMaxSec, 'reference')
  assert.equal(r(7.9).ok, false); assert.equal(r(8).ok, true); assert.equal(r(120).ok, true); assert.equal(r(120.5).ok, false)
  const c = (s: number) => m.checkDuration(s, m.LIMITS.consentMinSec, m.LIMITS.consentMaxSec, 'consent')
  assert.equal(c(2.9).ok, false); assert.equal(c(3).ok, true); assert.equal(c(40).ok, true); assert.equal(c(41).ok, false)
})

test('countdown and clock helpers', () => {
  const t0 = Date.parse('2026-10-06T10:00:00Z')
  assert.equal(m.secondsLeft('2026-10-06T10:05:00Z', t0), 300)
  assert.equal(m.secondsLeft('2026-10-06T10:05:00Z', t0 + 299_500), 1)
  assert.equal(m.secondsLeft('2026-10-06T10:05:00Z', t0 + 301_000), 0)
  assert.equal(m.secondsLeft('garbage', t0), 0)
  assert.equal(m.formatClock(300), '5:00'); assert.equal(m.formatClock(65.9), '1:05'); assert.equal(m.formatClock(-3), '0:00')
})

test('recorder mime pick and extensions', () => {
  assert.equal(m.pickRecorderMime((t) => t === 'audio/webm'), 'audio/webm')
  assert.equal(m.pickRecorderMime((t) => t === 'audio/mp4'), 'audio/mp4')
  assert.equal(m.pickRecorderMime(() => false), undefined)
  assert.equal(m.extensionForMime('audio/webm;codecs=opus'), 'webm'); assert.equal(m.extensionForMime('audio/mp4'), 'm4a')
})

test('every language option is a backend-supported code and samples fit the text limit', () => {
  const backend = ['ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh']
  assert.deepEqual(m.LANGUAGES.map((l: { code: string }) => l.code).sort(), backend)
  for (const s of Object.values(m.SAMPLE_SENTENCES) as string[]) assert.ok(s.length <= m.LIMITS.maxTextChars)
})

test('attestation_required maps to a confirm-your-voice message with no recovery action', () => {
  const e = m.mapCloneError(400, { code: 'attestation_required', error: 'x' })
  assert.equal(e.recovery, 'none'); assert.match(e.message, /own voice/)
})

test('selectCloneFlow: only an explicit consent_required:false selects attestation; everything else is strict', () => {
  assert.equal(m.selectCloneFlow({ consent_required: false }), 'attest')
  assert.equal(m.selectCloneFlow({ consent_required: true }), 'strict')
  for (const bad of [null, undefined, {}, { consent_required: 'false' }, { consent_required: 0 }, { consent_required: null }, 'x', []]) {
    assert.equal(m.selectCloneFlow(bad), 'strict', JSON.stringify(bad))
  }
})
