import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWav, pcm16ToWav, pcmDurationSeconds } from '../src/lib/mcp/wav.ts'
import { SlidingWindowLimiter } from '../src/lib/mcp/ratelimit.ts'
import { textToSpeechSchema, MAX_TEXT_CHARS } from '../src/lib/mcp/schemas.ts'
import { resolveVoice } from '../src/lib/mcp/voices.ts'

test('WAV header wraps PCM at 24 kHz mono 16-bit', () => {
  const pcm = Buffer.alloc(48000) // 1 s
  const wav = pcm16ToWav(pcm)
  assert.equal(wav.length, 44 + 48000)
  assert.deepEqual(parseWav(wav), { sampleRate: 24000, channels: 1, bits: 16, dataBytes: 48000, seconds: 1 })
  assert.equal(pcmDurationSeconds(96000), 2)
})

test('parseWav rejects non-WAV and size mismatch', () => {
  assert.throws(() => parseWav(Buffer.from('nope')))
  const wav = pcm16ToWav(Buffer.alloc(100))
  assert.throws(() => parseWav(wav.subarray(0, 120)))
})

test('sliding window limiter blocks then recovers', () => {
  const l = new SlidingWindowLimiter(2, 1000)
  assert.ok(l.check('a', 0).ok)
  assert.ok(l.check('a', 100).ok)
  const blocked = l.check('a', 200)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.retryAfterSec, 1)
  assert.ok(l.check('b', 200).ok, 'other keys unaffected')
  assert.ok(l.check('a', 1001).ok, 'first hit expired')
})

test('text_to_speech schema: defaults, limits, engine enum', () => {
  const ok = textToSpeechSchema.parse({ text: '  hello  ' })
  assert.deepEqual(ok, { text: 'hello', engine: 'piper', speed: 1 })
  assert.throws(() => textToSpeechSchema.parse({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }))
  assert.throws(() => textToSpeechSchema.parse({ text: '   ' }))
  assert.throws(() => textToSpeechSchema.parse({ text: 'hi', engine: 'other' }))
  assert.throws(() => textToSpeechSchema.parse({ text: 'hi', speed: 5 }))
  assert.equal(textToSpeechSchema.parse({ text: 'x'.repeat(MAX_TEXT_CHARS) }).text.length, MAX_TEXT_CHARS)
})

test('voice resolution', () => {
  assert.deepEqual(resolveVoice('piper', undefined), { voice: 'default' })
  assert.deepEqual(resolveVoice('kokoro', undefined), { voice: 'af_heart' })
  assert.deepEqual(resolveVoice('kokoro', 'bf_emma'), { voice: 'bf_emma' })
  assert.deepEqual(resolveVoice('piper', 'custom:abc_123'), { voice: 'custom:abc_123' })
  assert.ok('error' in resolveVoice('piper', 'af_heart'))
  assert.ok('error' in resolveVoice('kokoro', 'nope'))
  assert.ok('error' in resolveVoice('kokoro', 'custom:bad id!'))
})

test('warmStt: fire-and-forget POST to /stt/warm, deduped per key for 60 s, all errors swallowed', async () => {
  const { warmStt } = await import('../src/lib/mcp/upstream.ts')
  const real = globalThis.fetch
  const calls: Array<{ url: string; body: string }> = []
  let mode: 'ok' | '404' | 'reject' | 'throw' = 'ok'
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ url: String(url), body: init.body })
    if (mode === 'reject') throw new Error('network down')
    if (mode === 'throw') throw new TypeError('failure')
    return new Response(null, { status: mode === '404' ? 404 : 202 })
  }) as unknown as typeof fetch
  try {
    assert.equal(warmStt('sk_test_key_1', 'k1', 1_000_000), undefined)
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/stt/warm'))
    assert.deepEqual(JSON.parse(calls[0].body), { key: 'sk_test_key_1' })
    warmStt('sk_test_key_1', 'k1', 1_000_000 + 59_000) // deduped
    assert.equal(calls.length, 1)
    warmStt('sk_test_key_2', 'k2', 1_000_000 + 59_000) // other key unaffected
    assert.equal(calls.length, 2)
    warmStt('sk_test_key_1', 'k1', 1_000_000 + 60_001) // window passed
    assert.equal(calls.length, 3)
    for (const m of ['404', 'reject', 'throw'] as const) { // none may throw or leave an unhandled rejection
      mode = m
      warmStt('sk_test_key_3', `k3-${m}`, 5_000_000)
    }
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls.length, 6)
  } finally { globalThis.fetch = real }
})
