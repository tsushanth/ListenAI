import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TTS_REGISTRY } from '../src/generated/tts-registry.ts'
import { KOKORO_VOICES, LIVE_VOICES, PUBLIC_VOICES, DEFAULT_LIVE_VOICE, DEFAULT_STUDIO_VOICE, STUDIO_UNSUPPORTED_VOICES, backendVoiceId, resolveVoice } from '../src/lib/mcp/voices.ts'
import { RA_LANGUAGES, RA_VOICES, RA_TIERS, RA_LIVE_LANGUAGE_ROWS } from '../src/content/readaloudFacts.ts'
// @ts-ignore plain .mjs script
import { build, llmsWith } from '../scripts/sync-tts-registry.mjs'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const read = (p: string) => readFileSync(here(p), 'utf8')

test('the generated .json and its .ts twin hold the same data, stamped with a registry hash', () => {
  const json = JSON.parse(read('../src/generated/tts-registry.json'))
  assert.deepEqual(JSON.parse(JSON.stringify(TTS_REGISTRY)), json)
  assert.match(json.registry.hash, /^[0-9a-f]{16}$/)
  assert.equal(json.registry.catalog, 'public-catalog.json')
})

test('counts add up and every language and voice list is consistent', () => {
  const r = TTS_REGISTRY
  assert.equal(r.counts.live, r.engines.live.voices.length)
  assert.equal(r.counts.studio, r.engines.studio.voices.length)
  assert.equal(r.counts.total, Object.values(r.engines).reduce((n, e) => n + e.voices.length, 0))
  for (const e of [r.engines.live, r.engines.studio]) {
    // A voice that speaks several languages (`languages`) is listed under each of them, so count distinct ids.
    const listed = new Set(Object.values(e.voicesByLanguage).flat())
    assert.equal(listed.size, e.voices.length)
    for (const v of e.voices) for (const c of (v as { languages?: readonly string[] }).languages ?? [v.language]) assert.ok((e.languages as readonly string[]).includes(c), `${v.id} language ${c}`)
  }
  assert.equal(RA_LIVE_LANGUAGE_ROWS.reduce((n, row) => n + row.voices.length, 0), r.counts.liveListedNonDefault)
})

test('docs never advertise a voice the worker cannot speak (hide-unsupported applied)', () => {
  const hidden = new Set(STUDIO_UNSUPPORTED_VOICES)
  assert.ok(hidden.size > 0, 'the registry currently hides some Studio voices')
  for (const id of KOKORO_VOICES) assert.ok(!hidden.has(id), `${id} is advertised but the worker cannot speak it`)
  for (const id of TTS_REGISTRY.engines.studio.voices.map((v) => v.id)) assert.ok(!hidden.has(id), id)
  assert.ok(KOKORO_VOICES.includes(DEFAULT_STUDIO_VOICE))
  assert.ok(!KOKORO_VOICES.includes('en-emma'), 'en-emma (old id bf_emma) is worker_supported=false in the registry')
  assert.ok(STUDIO_UNSUPPORTED_VOICES.includes('bf_emma'))
})

test('voice resolution: public ids pass, old ids map to the public id, a hidden Studio voice is still passed through, unknown ones are refused', () => {
  assert.deepEqual(resolveVoice('studio', 'en-heart'), { voice: 'en-heart' })
  assert.deepEqual(resolveVoice('studio', 'af_heart'), { voice: 'en-heart' }) // old id, mapped
  assert.deepEqual(resolveVoice('studio', 'bf_emma'), { voice: 'en-emma' }) // not advertised, not newly refused
  assert.ok('error' in resolveVoice('studio', 'nope'))
  assert.deepEqual(resolveVoice('live', undefined), { voice: DEFAULT_LIVE_VOICE })
  assert.deepEqual(resolveVoice('live', 'default'), { voice: 'default' }) // the old default id still passes through, unlisted
  assert.deepEqual(resolveVoice('studio', undefined), { voice: 'en-heart' })
  assert.deepEqual(resolveVoice('live', 'de-f1'), { voice: 'de-f1' })
  assert.deepEqual(resolveVoice('live', 'custom:de-de-mls-f'), { voice: 'de-f1' }) // old id, mapped
  assert.deepEqual(resolveVoice('live', 'custom:pt-br-cadu'), { voice: 'pt-br-m2' })
  assert.deepEqual(resolveVoice('live', 'custom:my_trained_voice'), { voice: 'custom:my_trained_voice' })
  assert.ok('error' in resolveVoice('live', 'af_heart'), 'a Studio voice is not a Live voice')
  assert.ok('error' in resolveVoice('studio', 'de-f1'))
  assert.ok(LIVE_VOICES.includes('pt-br-m2'))
  assert.equal(backendVoiceId('en-heart'), 'af_heart') // the audiobook route still takes the old ids
  assert.equal(backendVoiceId('something-else'), 'something-else')
})

test('list_voices data: public ids with name, language, dialect and gender only', () => {
  for (const t of ['live', 'studio'] as const) {
    assert.ok(PUBLIC_VOICES[t].length > 0)
    for (const v of PUBLIC_VOICES[t]) {
      assert.ok(Object.keys(v).every((k) => ['voice_id', 'name', 'language', 'languages', 'dialect', 'gender'].includes(k)), JSON.stringify(v))
      assert.match(v.voice_id, /^[a-z0-9][a-z0-9-]{1,40}$/)
    }
  }
  assert.equal(PUBLIC_VOICES.live[0].voice_id, TTS_REGISTRY.engines.live.defaultVoice?.id ?? TTS_REGISTRY.engines.live.voices[0].id)
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

// --- the sync script itself, against a synthetic registry (public-catalog.json + registry.json for the hash and old ids + the policy) ---
function fakeRegistry(patch?: (d: { reg: any; pub: any; policy: any }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tts-registry-'))
  mkdirSync(join(dir, 'dist'))
  const reg = {
    version: 1, hash: 'abcdef0123456789',
    engines: {
      e1: { label: 'Live', public_alias: 'live', tier: 'live', languages: ['en', 'fr'] },
      e2: { label: 'Studio', public_alias: 'studio', tier: 'studio', languages: ['en'] },
      e3: { label: 'Staged', public_alias: 'staged', tier: 'live', status: 'staged', languages: ['en'] },
    },
    voices: [
      { voice_id: 'default', engine: 'e1', language: 'en', surfaces: { api: false } },
      { voice_id: 'custom:fr-a', engine: 'e1', language: 'fr', status: 'live', surfaces: { api: true }, public_id: 'fr-f1', aliases: ['custom:fr-a'] },
      { voice_id: 'k1', engine: 'e2', language: 'en', status: 'live', surfaces: { api: true }, public_id: 'en-k1', aliases: ['k1'] },
      { voice_id: 'k2', engine: 'e2', language: 'en', status: 'live', surfaces: { api: true }, public_id: 'en-k2', aliases: ['k2'] },
      { voice_id: 'kx', engine: 'e2', language: 'en', status: 'live', surfaces: { api: true }, worker_supported: false, public_id: 'en-kx', aliases: ['kx'] },
      { voice_id: 'st:1', engine: 'e3', language: 'en', status: 'staged', surfaces: { api: true }, public_id: 'aria', aliases: ['st:1'] },
    ],
  }
  const pub = {
    tiers: { live: { languages: ['en', 'fr'] }, studio: { languages: ['en'] } },
    voices: [
      { voice_id: 'fr-f1', name: 'French female', language: 'fr', dialect: 'French', gender: 'female', tier: 'live' },
      { voice_id: 'en-k1', name: 'K1', language: 'en', dialect: 'American', gender: 'female', tier: 'studio' },
      { voice_id: 'en-k2', name: 'K2', language: 'en', dialect: 'American', gender: 'male', tier: 'studio' },
    ],
  }
  const policy = { denylist: ['secretmodel', 'fish speech'] }
  patch?.({ reg, pub, policy })
  writeFileSync(join(dir, 'dist/registry.json'), JSON.stringify(reg))
  writeFileSync(join(dir, 'dist/public-catalog.json'), JSON.stringify(pub))
  writeFileSync(join(dir, 'public-policy.json'), JSON.stringify(policy))
  return dir
}

test('sync: builds counts and phrases from the public catalog, maps old ids of live voices, and the same input gives the same output', () => {
  const dir = fakeRegistry()
  try {
    const a: any = build(dir)
    assert.deepEqual(build(dir), a)
    assert.deepEqual(a.counts, { total: 3, live: 1, studio: 2, liveListedNonDefault: 1 })
    assert.equal(a.phrase.llms, 'ReadAloud Live has a default English voice and 1 beta voices in French; ReadAloud Studio has 2 English voices. GET /v1/voices lists them.')
    assert.equal(a.registry.hash, 'abcdef0123456789')
    assert.equal(a.registry.catalog, 'public-catalog.json')
    assert.deepEqual(a.engines.live.defaultVoice, { id: 'default', name: 'Default', language: 'en' })
    assert.deepEqual(a.engines.studio.voices[0], { id: 'en-k1', name: 'K1', language: 'en', gender: 'female', dialect: 'American', beta: false })
    // old ids: live voices only (the hidden worker_supported=false voice is kept so a caller that sends it still gets through; the staged engine is not)
    assert.deepEqual(a._legacy, { 'custom:fr-a': { id: 'fr-f1', tier: 'live' }, k1: { id: 'en-k1', tier: 'studio' }, k2: { id: 'en-k2', tier: 'studio' }, kx: { id: 'en-kx', tier: 'studio' } })
    // nothing internal leaks into the public data
    const text = JSON.stringify({ ...a, _legacy: undefined })
    for (const internal of ['e1', 'e2', 'custom:fr-a', 'hardware', 'registryId', 'priceClass', 'worker']) assert.ok(!text.includes(internal), `public data mentions ${internal}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sync: an unknown language code, a voice outside its tier languages, a tier with no voices, a missing tier and a denylisted term all fail loudly', () => {
  const cases: Array<[RegExp, (d: { reg: any; pub: any; policy: any }) => void]> = [
    [/xx/, ({ pub }) => { pub.tiers.live.languages.push('xx') }],
    [/is not one of tier studio's languages/, ({ pub }) => { pub.voices[1].language = 'fr' }],
    [/have no listed voice/, ({ pub }) => { pub.voices = pub.voices.filter((v: any) => v.tier !== 'studio') }],
    [/lacks hash/, ({ reg }) => { delete reg.hash }],
    [/has no tier "studio"/, ({ pub }) => { delete pub.tiers.studio }],
    [/denylisted term \("secretmodel"\)/, ({ pub }) => { pub.voices[1].name = 'SecretModel voice' }],
    [/denylisted term \("fish speech"\)/, ({ pub }) => { pub.voices[2].dialect = 'Fish-Speech' }],
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
