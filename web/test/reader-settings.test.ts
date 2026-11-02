import { test } from 'node:test'
import assert from 'node:assert/strict'

const { READER_SPEEDS, READER_SETTINGS_KEY, normalizeSpeed, loadReaderSettings, saveReaderSettings } = await import('../src/lib/readerSettings.ts')

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}
const any = () => true

test('speed steps match the Android picker, 0.5x to 2x', () => {
  assert.deepEqual([...READER_SPEEDS], [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])
})

test('normalizeSpeed clamps to 0.5-2 and snaps to a step', () => {
  assert.equal(normalizeSpeed(1), 1)
  assert.equal(normalizeSpeed(3), 2)
  assert.equal(normalizeSpeed(0.1), 0.5)
  assert.equal(normalizeSpeed(-4), 0.5)
  assert.equal(normalizeSpeed(1.3), 1.25)
  assert.equal(normalizeSpeed('1.5'), 1.5)
  for (const bad of [NaN, Infinity, undefined, 'fast', {}]) assert.equal(normalizeSpeed(bad), 1, String(bad))
})

test('defaults when nothing is saved or storage is missing', () => {
  assert.deepEqual(loadReaderSettings(memoryStorage(), any), { voice: null, speed: 1 })
  assert.deepEqual(loadReaderSettings(null, any), { voice: null, speed: 1 })
})

test('saved voice and speed round-trip', () => {
  const s = memoryStorage()
  saveReaderSettings(s, { voice: 'custom:en-us-john', speed: 1.75 })
  assert.equal(JSON.parse(s.data.get(READER_SETTINGS_KEY)!).speed, 1.75)
  assert.deepEqual(loadReaderSettings(s, any), { voice: 'custom:en-us-john', speed: 1.75 })
})

test('a saved voice that is no longer offered is dropped but the speed is kept', () => {
  const s = memoryStorage()
  saveReaderSettings(s, { voice: 'custom:en-us-gone', speed: 0.75 })
  assert.deepEqual(loadReaderSettings(s, (id) => id === 'custom:en-us-warm-f'), { voice: null, speed: 0.75 })
})

test('corrupt or hostile stored values give safe settings', () => {
  for (const raw of ['not json', '{', 'null', '42', '"x"', '[]']) {
    assert.deepEqual(loadReaderSettings(memoryStorage({ [READER_SETTINGS_KEY]: raw }), any), { voice: null, speed: 1 }, raw)
  }
  const odd = memoryStorage({ [READER_SETTINGS_KEY]: JSON.stringify({ voice: 7, speed: 9 }) })
  assert.deepEqual(loadReaderSettings(odd, any), { voice: null, speed: 2 })
})

test('storage that throws never breaks the reader', () => {
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.deepEqual(loadReaderSettings(broken, any), { voice: null, speed: 1 })
  assert.doesNotThrow(() => saveReaderSettings(broken, { voice: 'custom:en-us-john', speed: 1 }))
})
