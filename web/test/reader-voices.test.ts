import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { READER_VOICES, DEFAULT_READER_VOICE_ID, isReaderVoiceId, resolveReaderVoice } = await import('../src/lib/readerVoices.ts')
const { PIPER_VOICE } = await import('../src/lib/piperReader.ts')

const MAPPING_KT = fileURLToPath(new URL('../../android/app/src/main/java/com/listenai/service/tts/PiperVoiceMapping.kt', import.meta.url))

test('the default reader voice is the existing house voice', () => {
  assert.equal(DEFAULT_READER_VOICE_ID, PIPER_VOICE)
  assert.equal(READER_VOICES[0]!.id, PIPER_VOICE)
})

test('voice ids are unique, well formed Piper custom ids, and every entry is labelled', () => {
  const ids = READER_VOICES.map((v) => v.id)
  assert.equal(new Set(ids).size, ids.length)
  const names = READER_VOICES.map((v) => v.name)
  assert.equal(new Set(names).size, names.length)
  for (const v of READER_VOICES) {
    assert.match(v.id, /^custom:en-[a-z]{2}-[a-z0-9_-]+$/, v.id)
    assert.ok(v.name.trim() && v.description.trim(), v.id)
  }
})

test('the picker holds the 10 Android voices plus Warm', () => {
  assert.equal(READER_VOICES.length, 11)
  assert.deepEqual(
    READER_VOICES.slice(1).map((v) => v.name),
    ['Bella', 'Adam', 'Brian', 'Charlotte', 'Josh', 'Matilda', 'Bill', 'Elli', 'Dorothy', 'Rachel'],
  )
})

test('every voice id Android maps is offered on the web, with the same name', { skip: !existsSync(MAPPING_KT) && 'android sources not checked out' }, () => {
  const kt = readFileSync(MAPPING_KT, 'utf8')
  const pairs = [...kt.matchAll(/"([a-z]+)"\s+to\s+"(custom:[A-Za-z0-9_-]+)"/g)].map((m) => ({ name: m[1]!, id: m[2]! }))
  assert.equal(pairs.length, 10)
  for (const p of pairs) {
    const web = READER_VOICES.find((v) => v.id === p.id)
    assert.ok(web, `${p.id} (${p.name}) is in Android's PiperVoiceMapping but not in READER_VOICES`)
    assert.equal(web!.name.toLowerCase(), p.name, p.id)
  }
  const androidIds = new Set(pairs.map((p) => p.id))
  const webOnly = READER_VOICES.filter((v) => !androidIds.has(v.id)).map((v) => v.id)
  assert.deepEqual(webOnly, [PIPER_VOICE]) // the only web-only voice is the original Warm default
})

test('resolveReaderVoice keeps known ids and falls back to the default for anything else', () => {
  assert.equal(resolveReaderVoice('custom:en-us-john'), 'custom:en-us-john')
  for (const bad of [undefined, null, '', 'custom:de-de-mls-f', 'bella', 'custom:en-us-john ', '../etc/passwd']) {
    assert.equal(resolveReaderVoice(bad as string | null | undefined), DEFAULT_READER_VOICE_ID, String(bad))
  }
  assert.equal(isReaderVoiceId('custom:en-gb-vctk-p229'), true)
  assert.equal(isReaderVoiceId(42), false)
})
