import { test } from 'node:test'
import assert from 'node:assert/strict'

const { creditsAsCharacters, FREE_CREDIT_UNITS, FREE_CREDIT_USD, priceLine } = await import('../src/lib/pricing.ts')

test('free credit grant matches the documented $0.10 / 10,000 characters', () => {
  assert.equal(FREE_CREDIT_UNITS, 10000)
  assert.equal(Math.round(FREE_CREDIT_UNITS * 0.00001 * 100) / 100, FREE_CREDIT_USD)
})

test('creditsAsCharacters renders a friendly line and never goes negative', () => {
  assert.equal(creditsAsCharacters(10000), 'about 10,000 characters of speech')
  assert.equal(creditsAsCharacters(2500), 'about 2,500 characters of speech')
  assert.equal(creditsAsCharacters(-5), 'about 0 characters of speech')
})

test('priceLine for a priced tool is unchanged', () => {
  assert.match(priceLine('dubbing'), /\$0\.15 per minute of source audio/)
})
