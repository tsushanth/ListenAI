import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONTENT_DIR, contentDir, loadLibrary } from '../../src/lib/seoLibrary/load.ts'
import { FIXTURE_DIR } from './helpers.ts'

function tmp(files: Record<string, unknown>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-lib-'))
  for (const [f, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true })
    fs.writeFileSync(path.join(d, f), typeof v === 'string' ? v : JSON.stringify(v))
  }
  return d
}
const vendor = () => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'vendors', 'elevenlabs.json'), 'utf8'))

test('fixtures load: 2 vendors, 2 use cases, 2 integrations, nothing published', () => {
  const lib = loadLibrary(FIXTURE_DIR)
  assert.deepEqual(lib.vendors.map((v) => v.slug), ['elevenlabs', 'openai-tts'])
  assert.equal(lib.useCases.length, 2)
  assert.equal(lib.integrations.length, 2)
  assert.deepEqual(lib.publish.published, [])
})

test('production loader reads src/content only; fixtures are used only when SEO_LIBRARY_DIR is set', () => {
  const prev = process.env.SEO_LIBRARY_DIR
  delete process.env.SEO_LIBRARY_DIR
  assert.equal(contentDir(), DEFAULT_CONTENT_DIR)
  assert.ok(DEFAULT_CONTENT_DIR.endsWith(path.join('src', 'content')))
  process.env.SEO_LIBRARY_DIR = FIXTURE_DIR
  assert.equal(contentDir(), FIXTURE_DIR)
  if (prev === undefined) delete process.env.SEO_LIBRARY_DIR
  else process.env.SEO_LIBRARY_DIR = prev
})

test('no fixture marker exists under src/content', () => {
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
  for (const f of walk(DEFAULT_CONTENT_DIR).filter((x) => x.endsWith('.json'))) assert.ok(!fs.readFileSync(f, 'utf8').includes('"_fixture"'), `${f} is a test fixture`)
})

test('missing directories and a missing publish.json mean an empty library', () => {
  const lib = loadLibrary(tmp({}))
  assert.equal(lib.vendors.length + lib.useCases.length + lib.integrations.length, 0)
  assert.deepEqual(lib.publish.published, [])
})

test('nulls are accepted for every nullable field (the Calldesk strict-schema bug)', () => {
  const v = vendor()
  v.pricing.pricePer1MCharsUsd = null
  v.pricing.freeTier = null
  v.pricing.headline = null
  v.pricing.tiers[0].pricePer1MCharsUsd = null
  v.pricing.tiers[0].notes = null
  v.voices = { count: null, languages: null, customVoiceOrCloning: null, sourceUrl: null }
  v.streaming = { websocket: null, http: null, vendorStatedLatency: null, sourceUrl: null }
  v.ssml = null
  v.compatibility = { openaiSpeechCompatible: null, note: null }
  v.licensing = { commercialUse: null, attributionOrConditions: null, sourceUrl: null }
  v.limits = { perRequestCharacters: null, concurrency: null, sourceUrl: null }
  v.compliance = { hipaa: null, soc2: null, gdpr: null, note: null, sourceUrl: null }
  v.bestFor = null
  v.sdks = null
  v.unknowns = null
  v.formats = null
  const lib = loadLibrary(tmp({ 'vendors/elevenlabs.json': v }))
  const got = lib.vendors[0]
  assert.equal(got.voices.count, '')
  assert.equal(got.streaming.websocket, 'unknown')
  assert.equal(got.compliance.soc2, 'not-stated')
  assert.equal(got.voices.sourceUrl, undefined)
  assert.deepEqual(got.formats, [])
})

test('booleans and numbers written by researchers are normalised', () => {
  const v = vendor()
  v.streaming.websocket = true
  v.ssml = false
  v.voices.count = 120
  v.limits.perRequestCharacters = 5000
  const got = loadLibrary(tmp({ 'vendors/elevenlabs.json': v })).vendors[0]
  assert.equal(got.streaming.websocket, 'yes')
  assert.equal(got.ssml, 'no')
  assert.equal(got.voices.count, '120')
  assert.equal(got.limits.perRequestCharacters, '5000')
})

test('a wrong shape, a slug that differs from the file name, and invalid JSON all throw with the file named', () => {
  const v = vendor()
  assert.throws(() => loadLibrary(tmp({ 'vendors/elevenlabs.json': { ...v, status: 'maybe' } })), /vendors\/elevenlabs\.json: status/)
  assert.throws(() => loadLibrary(tmp({ 'vendors/other.json': v })), /does not match the file name/)
  assert.throws(() => loadLibrary(tmp({ 'vendors/elevenlabs.json': '{ nope' })), /not valid JSON/)
  assert.throws(() => loadLibrary(tmp({ 'vendors/elevenlabs.json': { ...v, retrievedAt: '2026-13-45' } })), /retrievedAt/)
  assert.throws(() => loadLibrary(tmp({ 'publish.json': { published: ['Bad Slug'] } })), /publish\.json/)
})

test('counts are validator rules, not schema rules: a short use case still loads', () => {
  const uc = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'use-cases', 'voice-agents.json'), 'utf8'))
  uc.steps = ['one']
  uc.faq = []
  assert.equal(loadLibrary(tmp({ 'use-cases/voice-agents.json': uc })).useCases.length, 1)
})
