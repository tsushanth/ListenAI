import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Privacy policy and terms must not make claims the Android app contradicts. Evidence:
//  - no consent gate before reading text goes to api.readaloudai.org: android TtsChainProvider / TtsFlagLogic.inAppOrder (API first, no consent check)
//  - crash reports are always on: android FailureReporter, initialised in ListenAIApplication for the reader flavor
//  - no ElevenLabs or OpenAI key on the backend, LLM calls go to Anthropic: backend/src/lib/config.ts
//  - no account-deletion flow in the app, backend or website; deletion is by email
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const privacy = read('../src/app/privacy/page.tsx')
const terms = read('../src/app/terms/page.tsx')

test('policy does not claim a consent prompt before data is sent', () => {
  for (const [name, src] of [['privacy', privacy], ['terms', terms]] as const) {
    assert.doesNotMatch(src, /asks for your explicit consent/i, `${name}: consent claim`)
    assert.doesNotMatch(src, /revoke (this |your )?consent/i, `${name}: revocable consent claim`)
  }
})

test('policy names the speech service, crash reports, RevenueCat and Google sign-in', () => {
  assert.match(privacy, /api\.readaloudai\.org/)
  assert.match(privacy, /app-failure-reporter/)
  assert.match(privacy, /RevenueCat/)
  assert.match(privacy, /Google sign-in/)
})

test('policy does not name providers the product no longer uses', () => {
  for (const [name, src] of [['privacy', privacy], ['terms', terms]] as const) {
    assert.doesNotMatch(src, /ElevenLabs|OpenAI|RunPod/i, `${name}: stale provider`)
  }
})

test('policy does not promise non-retention it cannot verify', () => {
  assert.doesNotMatch(privacy, /speech (servers?|service)[^.]{0,80}(do not|does not|never) (log|retain|store|keep)/i)
  assert.match(privacy, /have not (completed a review|verified)/i)
})

test('account deletion is an email process with a real address, not a self-serve flow', () => {
  assert.match(privacy, /Deleting Your Account and Data/)
  assert.match(privacy, /mailto:puzzleverseai@gmail\.com/)
  assert.match(privacy, /no delete-account button/i)
  assert.doesNotMatch(privacy, /Delete your account and associated data/)
})

test('terms do not promise a trial or money-back guarantee that checkout does not honour', () => {
  assert.doesNotMatch(terms, /money-back guarantee\)|7-day trial/i)
})

test('last-updated dates are current', () => {
  assert.match(privacy, /Last updated: November 10, 2026/)
  assert.match(terms, /Last updated: November 10, 2026/)
})
