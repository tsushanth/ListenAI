import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as facts from '../../src/content/readaloudFacts.ts'
import { findBanned, BANNED_STRICT } from '../../src/lib/seoLibrary/banned.ts'
import { findCertClaims } from '../../src/lib/seoLibrary/certs.ts'
import { buildPages, hubModels } from '../../src/lib/seoLibrary/pages.ts'
import { textOfPage } from '../../src/lib/seoLibrary/text.ts'
import { fixtureLibrary } from './helpers.ts'

const SRC = path.join(process.cwd(), 'src', 'lib', 'seoLibrary')
const TEMPLATES = ['pages.ts', 'compare.ts', 'alternatives.ts', 'migrate.ts']

test('templates type no ReadAloud price, limit or number: facts come from readaloudFacts.ts', () => {
  for (const f of TEMPLATES) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    const strings = code.match(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g) ?? []
    for (const s of strings) {
      assert.ok(!/\$\d/.test(s), `${f}: money amount in ${s.slice(0, 80)}`)
      const stripped = s.replace(/\$\{[^}]*\}/g, '').replace(/\bSOC 2\b|\b120\b|\b402\b|\b429\b|\b400\b|\b1M\b|\b1 million\b|\b8 kHz\b|\b1,000\b/g, '')
      assert.ok(!/\d{2,}|\b[2-9]\b/.test(stripped), `${f}: number in ${s.slice(0, 80)}`)
    }
  }
})

test('readaloudFacts: per-1,000 and per-1M prices agree, tiers are named, no engine names, no certification claims', () => {
  for (const t of facts.RA_TIERS) assert.equal(Math.round(t.per1kUsd * 1000 * 1e6), Math.round(t.per1MUsd * 1e6), t.name)
  assert.equal(facts.RA_LIVE.per1MUsd, 4)
  assert.equal(facts.RA_STUDIO.per1MUsd, 10)
  assert.equal(facts.RA_LIMITS.perRequestCharacters, 5000)
  assert.deepEqual(facts.RA_CERTIFICATION_ALLOW_LIST, [])
  const text = JSON.stringify([facts.RA_TIERS, facts.RA_BILLING, facts.RA_FREE_CREDITS, facts.RA_LIMITS, facts.RA_FORMATS, facts.RA_STREAMING, facts.RA_OPENAI_ROUTE, facts.RA_ELEVENLABS_ROUTES, facts.RA_VOICES, facts.RA_LANGUAGES, facts.RA_CLONING, facts.RA_COMPLIANCE_STATEMENT, facts.RA_INTEGRATIONS])
  assert.deepEqual(findBanned(text, facts.RA_FORBIDDEN_ENGINE_NAMES), [])
  assert.deepEqual(findBanned(text, BANNED_STRICT), [], 'facts that pages print must pass the strict wording gate')
  assert.deepEqual(findCertClaims(text), [])
  assert.equal(facts.RA_LATENCY.renderHeadToHeadOnLibraryPages, false)
})

test('no page prints a head-to-head latency figure for ElevenLabs or any other vendor', () => {
  for (const p of buildPages(fixtureLibrary())) {
    const text = textOfPage(p)
    assert.ok(!text.includes(`${facts.RA_LATENCY.headToHeadElevenLabsFlashMs} ms`), p.path)
    if (p.type === 'compare') assert.match(text, /Vendor-stated:|Not stated on the pages we reviewed/)
  }
})

test('rendered pages and hubs never name the engines, never claim a certification, never use banned words', () => {
  const lib = fixtureLibrary()
  const texts = [...buildPages(lib).map((p) => textOfPage(p)), ...Object.values(hubModels()).map((h) => `${h.title} ${h.description} ${h.lede}`)]
  for (const t of texts) {
    assert.deepEqual(findBanned(t.replace(/Kokoro/g, ''), facts.RA_FORBIDDEN_ENGINE_NAMES), [])
    assert.deepEqual(findCertClaims(t).filter((c) => c.raSubject), [])
  }
  for (const h of Object.values(hubModels())) assert.deepEqual(findBanned(`${h.title} ${h.description} ${h.h1} ${h.lede}`, BANNED_STRICT), [], h.path)
})

test('titles and descriptions are unique and inside the length limits', () => {
  const lib = fixtureLibrary()
  const pages = buildPages(lib)
  assert.equal(new Set(pages.map((p) => p.title)).size, pages.length)
  assert.equal(new Set(pages.map((p) => p.description)).size, pages.length)
  for (const p of pages.filter((x) => x.type === 'compare' || x.type === 'alternatives' || x.type === 'migrate')) {
    assert.ok(p.title.length <= 70, `${p.path} title ${p.title.length}`)
    assert.ok(p.description.length <= 165, `${p.path} description ${p.description.length}`)
  }
})

test('the library does not touch the hand-written migration page and links to it', () => {
  const p = buildPages(fixtureLibrary()).find((x) => x.path === '/compare/readaloud-vs-elevenlabs')!
  assert.match(JSON.stringify(p.blocks), /\/developers\/migrate-from-elevenlabs/)
  assert.ok(!buildPages(fixtureLibrary()).some((x) => x.path === '/migrate/from-elevenlabs'))
  assert.ok(fs.existsSync(path.join(process.cwd(), 'src/app/developers/migrate-from-elevenlabs/page.tsx')))
})
