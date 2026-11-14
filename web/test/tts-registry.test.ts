import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TTS_REGISTRY } from '../src/generated/tts-registry.ts'
import { KOKORO_VOICES, LIVE_VOICES, PIPER_VOICES, DEFAULT_KOKORO_VOICE, STUDIO_UNSUPPORTED_VOICES, resolveVoice } from '../src/lib/mcp/voices.ts'
import { RA_LANGUAGES, RA_VOICES, RA_TIERS, RA_LIVE_LANGUAGE_ROWS } from '../src/content/readaloudFacts.ts'
// @ts-ignore plain .mjs script
import { build, llmsWith } from '../scripts/sync-tts-registry.mjs'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const read = (p: string) => readFileSync(here(p), 'utf8')

test('the generated .json and its .ts twin hold the same data, stamped with a registry hash', () => {
  const json = JSON.parse(read('../src/generated/tts-registry.json'))
  assert.deepEqual(JSON.parse(JSON.stringify(TTS_REGISTRY)), json)
  assert.match(json.registry.hash, /^[0-9a-f]{16}$/)
  assert.equal(json.registry.catalog, 'gateway-catalog.hide-unsupported.json')
})

test('counts add up and every language and voice list is consistent', () => {
  const r = TTS_REGISTRY
  assert.equal(r.counts.live, r.engines.live.voices.length)
  assert.equal(r.counts.studio, r.engines.studio.voices.length)
  assert.equal(r.counts.total, Object.values(r.engines).reduce((n, e) => n + e.voices.length, 0))
  for (const e of [r.engines.live, r.engines.studio]) {
    const listed = Object.values(e.voicesByLanguage).flat()
    assert.equal(listed.length, e.voices.length)
    for (const v of e.voices) assert.ok((e.languages as readonly string[]).includes(v.language), `${v.id} language ${v.language}`)
  }
  assert.equal(RA_LIVE_LANGUAGE_ROWS.reduce((n, row) => n + row.voices.length, 0), r.counts.liveListedNonDefault)
})

test('docs never advertise a voice the worker cannot speak (hide-unsupported applied)', () => {
  const hidden = new Set(STUDIO_UNSUPPORTED_VOICES)
  assert.ok(hidden.size > 0, 'the registry currently hides some Studio voices')
  for (const id of KOKORO_VOICES) assert.ok(!hidden.has(id), `${id} is advertised but the worker cannot speak it`)
  for (const id of TTS_REGISTRY.engines.studio.voices.map((v) => v.id)) assert.ok(!hidden.has(id), id)
  assert.ok(KOKORO_VOICES.includes(DEFAULT_KOKORO_VOICE))
  assert.ok(!KOKORO_VOICES.includes('bf_emma'), 'bf_emma is worker_supported=false in the registry')
})

test('voice resolution: listed voices pass, a hidden Studio voice is still passed through as before, unknown ones are refused', () => {
  assert.deepEqual(resolveVoice('studio', 'af_heart'), { voice: 'af_heart' })
  assert.deepEqual(resolveVoice('studio', 'bf_emma'), { voice: 'bf_emma' }) // not advertised, not newly refused
  assert.ok('error' in resolveVoice('studio', 'nope'))
  assert.deepEqual(resolveVoice('live', undefined), { voice: 'default' })
  assert.deepEqual(resolveVoice('live', 'custom:de-de-mls-f'), { voice: 'custom:de-de-mls-f' })
  assert.ok(LIVE_VOICES.includes('default') && LIVE_VOICES.includes('custom:pt-br-cadu'))
  assert.deepEqual([...PIPER_VOICES], ['default']) // list_voices (server.ts) still returns this; see the hand-off note
})

test('facts: Live is not "one voice" and not "English today"', () => {
  const live = RA_TIERS.find((t) => t.id === 'live')!
  const text = [live.voices, RA_VOICES.short, RA_VOICES.liveCell, RA_LANGUAGES.short, RA_LANGUAGES.statement, RA_LANGUAGES.faq].join(' | ')
  assert.doesNotMatch(text, /one American English voice|single American English voice|English today/i)
  for (const code of TTS_REGISTRY.engines.live.languages) assert.ok(text.includes(TTS_REGISTRY.languageNames[code as keyof typeof TTS_REGISTRY.languageNames]), `Live language ${code} is named`)
  assert.ok(RA_VOICES.short.includes(String(TTS_REGISTRY.counts.liveListedNonDefault)))
  assert.ok(RA_VOICES.short.includes(String(TTS_REGISTRY.counts.studio)))
})

test('llms.txt carries the registry line the sync script generates, and no stale voice claims', () => {
  const llms = read('../public/llms.txt')
  assert.ok(llms.split('\n').includes(`- Voices and languages: ${TTS_REGISTRY.phrase.llms}`), 'run: node scripts/sync-tts-registry.mjs --registry <registry dir>')
  assert.equal(llmsWith(llms, TTS_REGISTRY), llms)
  assert.doesNotMatch(llms, /one voice|English today|several English voices/i)
})

test('pages carry no hand-typed voice or language claim that the registry contradicts', () => {
  for (const f of ['../src/app/page.tsx', '../src/app/developers/page.tsx']) {
    const src = read(f)
    assert.doesNotMatch(src, /One American English voice|English today|one English voice|ten beta voices|has one voice/i, f)
  }
  const home = read('../src/app/page.tsx')
  assert.match(home, /RA_VOICES\.liveCell/)
  assert.match(home, /RA_LANGUAGES\.faq/)
  const dev = read('../src/app/developers/page.tsx')
  assert.match(dev, /RA_LIVE_LANGUAGE_ROWS\.map/)
  assert.doesNotMatch(dev, /<td>(German|Spanish|French|Italian|Portuguese \(Brazil\))<\/td>/, 'the Languages table rows come from the registry')
})

test('MCP page, MCP server text and the two edited use cases make no stale voice claim', () => {
  const stale = /has one voice|28 English voices|bf_emma|bf_\/bm_|one American English voice|English today|Live has one voice/i
  for (const f of ['../src/app/developers/mcp/page.tsx', '../src/lib/mcp/server.ts', '../src/content/use-cases/voice-agents-and-ivr.json',
    '../src/content/use-cases/article-and-newsletter-to-audio.json', '../test/fixtures/seo-library/use-cases/voice-agents.json']) {
    assert.doesNotMatch(read(f), stale, f)
  }
  assert.match(read('../src/app/developers/mcp/page.tsx'), /RA_VOICE_COUNTS\.studio/)
  assert.match(read('../src/lib/mcp/server.ts'), /TTS_REGISTRY\.counts\.studio/)
})

// --- the sync script itself, against a synthetic registry ---
function fakeRegistry(patch?: (d: { reg: any; cat: any }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tts-registry-'))
  mkdirSync(join(dir, 'dist'))
  const reg = {
    version: 1, hash: 'abcdef0123456789',
    engines: {
      piper: { label: 'Live', public_alias: 'live', hardware: 'cpu', price_class: 'live', languages: ['en', 'fr'] },
      kokoro: { label: 'Studio', public_alias: 'studio', hardware: 'gpu', price_class: 'studio', languages: ['en'] },
    },
    voices: [
      { voice_id: 'default', engine: 'piper', language: 'en', surfaces: { api: false } },
      { voice_id: 'custom:fr-a', engine: 'piper', language: 'fr', surfaces: { api: true } },
      { voice_id: 'k1', engine: 'kokoro', language: 'en', surfaces: { api: true } },
      { voice_id: 'k2', engine: 'kokoro', language: 'en', surfaces: { api: true } },
      { voice_id: 'kx', engine: 'kokoro', language: 'en', surfaces: { api: true }, worker_supported: false },
    ],
  }
  const cat = {
    builtIn: [{ voice_id: 'k1', name: 'K1', language: 'en', gender: 'female' }, { voice_id: 'k2', name: 'K2', language: 'en', gender: 'male' }],
    piperLanguage: [{ voice_id: 'custom:fr-a', name: 'French', language: 'fr', gender: 'female', description: 'Beta. Something.', engine: 'piper' }],
  }
  patch?.({ reg, cat })
  writeFileSync(join(dir, 'dist/registry.json'), JSON.stringify(reg))
  writeFileSync(join(dir, 'dist/gateway-catalog.hide-unsupported.json'), JSON.stringify(cat))
  return dir
}

test('sync: builds counts, phrases and hidden voices from the registry dist, and the same input gives the same output', () => {
  const dir = fakeRegistry()
  try {
    const a: any = build(dir)
    assert.deepEqual(build(dir), a)
    assert.deepEqual(a.counts, { total: 3, live: 1, studio: 2, liveListedNonDefault: 1 })
    assert.equal(a.phrase.llms, 'ReadAloud Live has a default English voice and 1 beta voices in French; ReadAloud Studio has 2 English voices. GET /v1/voices lists them.')
    assert.deepEqual(a.hiddenUnsupportedVoiceIds, { studio: ['kx'] })
    assert.equal(a.registry.hash, 'abcdef0123456789')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sync: an unknown language code, a voice outside its engine languages, and an empty engine all fail loudly', () => {
  const cases: Array<[RegExp, (d: { reg: any; cat: any }) => void]> = [
    [/xx/, ({ reg }) => { reg.engines.piper.languages.push('xx') }],
    [/is not one of kokoro's languages/, ({ cat }) => { cat.builtIn[0].language = 'fr' }],
    [/lists no voices/, ({ cat }) => { cat.builtIn = [] }],
    [/lacks hash/, ({ reg }) => { delete reg.hash }],
  ]
  for (const [re, patch] of cases) {
    const dir = fakeRegistry(patch)
    try { assert.throws(() => build(dir), re) } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('sync --check passes against the registry in TTS_REGISTRY_DIR when it is available', { skip: !process.env.TTS_REGISTRY_DIR || !existsSync(process.env.TTS_REGISTRY_DIR || '') }, () => {
  const r = spawnSync(process.execPath, [here('../scripts/sync-tts-registry.mjs'), '--check'], { env: process.env, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})
