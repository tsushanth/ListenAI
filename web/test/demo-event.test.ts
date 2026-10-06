import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseDemoEvent } = await import('../src/lib/demoEvent.ts')

test('accepts a well-formed play event and keeps only the safe fields', () => {
  const e = parseDemoEvent({ kind: 'play', sid: 'abc12345xyz', preset: 2, chars: 80, text: 'secret typed text' } as never)
  assert.deepEqual(e, { kind: 'play', sid: 'abc12345xyz', preset: 2, chars: 80, firstMs: null, audioMs: null, reason: null })
})

test('rejects unknown kinds, missing or malformed session ids and non-objects', () => {
  assert.equal(parseDemoEvent({ kind: 'hack', sid: 'abc12345xyz' }), null)
  assert.equal(parseDemoEvent({ kind: 'play', sid: 'x' }), null)
  assert.equal(parseDemoEvent({ kind: 'play', sid: '../../etc/passwd' }), null)
  assert.equal(parseDemoEvent(null), null)
})

test('clamps numbers and strips odd characters from the reason', () => {
  const e = parseDemoEvent({ kind: 'error', sid: 'abc12345xyz', preset: 999, chars: -5, firstMs: 1e9, audioMs: 12.6, reason: '<script>capacity' })!
  assert.equal(e.preset, 20)
  assert.equal(e.chars, 0)
  assert.equal(e.firstMs, 60000)
  assert.equal(e.audioMs, 13)
  assert.equal(e.reason, 'scriptcapacity')
})
