import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSynthesizeMessage, isEnglishPiperVoice, piperNormalizeFields } from '../src/lib/piperNormalize.ts'

test('English Piper voices get normalize:auto', () => {
  for (const v of [undefined, null, '', 'default', 'custom:en-us-warm-f', 'custom:en-gb-vctk-p229', 'CUSTOM:EN-US-JOHN', 'af_heart']) {
    assert.deepEqual(piperNormalizeFields(v), { normalize: 'auto' }, String(v))
  }
})

test('non-English or unknown-language custom voices send no normalize field', () => {
  for (const v of ['custom:de-de-mls-f', 'custom:fr-fr-mls-m', 'custom:es-pilot-f', 'custom:it-it-paola', 'custom:pt-br-cadu', 'custom:a1b2c3d4']) {
    assert.equal(isEnglishPiperVoice(v), false, v)
    assert.deepEqual(piperNormalizeFields(v), {}, v)
  }
})

test('an explicit caller value wins, including off and on non-English voices', () => {
  assert.deepEqual(piperNormalizeFields('custom:en-us-warm-f', 'off'), { normalize: 'off' })
  assert.deepEqual(piperNormalizeFields('default', 'basic'), { normalize: 'basic' })
  assert.deepEqual(piperNormalizeFields('custom:de-de-mls-f', 'auto'), { normalize: 'auto' })
})

test('synthesize message carries normalize only when set', () => {
  const on = JSON.parse(buildSynthesizeMessage({ text: 'See you at 9 AM', voice: 'custom:en-us-warm-f', speed: 1, ...piperNormalizeFields('custom:en-us-warm-f') }))
  assert.deepEqual(on, { type: 'synthesize', text: 'See you at 9 AM', voice: 'custom:en-us-warm-f', speed: 1, normalize: 'auto' })
  const off = JSON.parse(buildSynthesizeMessage({ text: 'x', voice: 'custom:en-us-warm-f', speed: 1, ...piperNormalizeFields('custom:en-us-warm-f', 'off') }))
  assert.equal(off.normalize, 'off')
  const de = JSON.parse(buildSynthesizeMessage({ text: 'x', voice: 'custom:de-de-mls-f', speed: 1, ...piperNormalizeFields('custom:de-de-mls-f') }))
  assert.equal('normalize' in de, false)
})

test('text_to_speech schema accepts an optional normalize and rejects unknown modes', async () => {
  const { textToSpeechSchema } = await import('../src/lib/mcp/schemas.ts')
  assert.equal(textToSpeechSchema.parse({ text: 'hi' }).normalize, undefined)
  assert.equal(textToSpeechSchema.parse({ text: 'hi', normalize: 'off' }).normalize, 'off')
  assert.equal(textToSpeechSchema.parse({ text: 'hi', normalize: 'auto' }).normalize, 'auto')
  assert.throws(() => textToSpeechSchema.parse({ text: 'hi', normalize: 'maybe' }))
})
