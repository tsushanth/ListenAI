import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateLibrary, validatePage, validateVendor, LIMITS, type Issue } from '../../src/lib/seoLibrary/validate.ts'
import { buildPages } from '../../src/lib/seoLibrary/pages.ts'
import { findBanned, BANNED_STRICT, BANNED_LITE } from '../../src/lib/seoLibrary/banned.ts'
import { findCertClaims } from '../../src/lib/seoLibrary/certs.ts'
import { SIMILARITY } from '../../src/lib/seoLibrary/similarity.ts'
import type { Library } from '../../src/lib/seoLibrary/load.ts'
import type { Vendor } from '../../src/lib/seoLibrary/schema.ts'
import { NOW, fixtureLibrary, syntheticVendors } from './helpers.ts'

const opts = { checkRelated: false }
const run = (lib: Library) => validateLibrary(lib, NOW, opts)
const codes = (is: Issue[]) => is.map((i) => `${i.severity}:${i.code}`)
const withVendor = (lib: Library, slug: string, f: (v: Vendor) => void): Library => {
  const copy = structuredClone(lib)
  f(copy.vendors.find((v) => v.slug === slug)!)
  return copy
}

test('fixtures produce no errors', () => {
  const r = run(fixtureLibrary())
  assert.deepEqual(r.errors, [], r.errors.map((e) => `${e.code} ${e.where} ${e.message}`).join('\n'))
  assert.equal(r.pages.length, 9) // 2 compare + 2 alternatives + 1 migrate (elevenlabs is hand-written) + 2 integrations + 2 use cases
})

test('limits are the documented numbers', () => {
  assert.deepEqual(SIMILARITY, { shingleWords: 5, maxPairJaccard: 0.5, warnPairJaccard: 0.35, minUniqueShare: 0.4, warnUniqueShare: 0.5 })
  assert.equal(LIMITS.minWords.compare, 500)
  assert.equal(LIMITS.introMinWords, 150)
})

test('every vendor fact needs a sourceUrl that is listed in sources[]', () => {
  const lib = fixtureLibrary()
  const v = structuredClone(lib.vendors[0])
  v.strengths[0].sourceUrl = 'https://unlisted.example.com/x'
  assert.ok(codes(validateVendor(v, NOW)).includes('error:FACT_SOURCE_NOT_LISTED'))
  const v2 = structuredClone(lib.vendors[0])
  v2.voices.sourceUrl = undefined
  assert.ok(codes(validateVendor(v2, NOW)).includes('error:FACT_NO_SOURCE'))
  const v3 = structuredClone(lib.vendors[0])
  v3.pricing.sourceUrls = []
  assert.ok(codes(validateVendor(v3, NOW)).includes('error:FACT_NO_SOURCE'))
  const v4 = structuredClone(lib.vendors[0])
  v4.streaming.sourceUrl = undefined
  assert.ok(codes(validateVendor(v4, NOW)).includes('error:FACT_NO_SOURCE'))
})

test('dates must be real and not in the future; old data warns', () => {
  const v = structuredClone(fixtureLibrary().vendors[0])
  v.retrievedAt = '2026-12-01'
  assert.ok(codes(validateVendor(v, NOW)).includes('error:DATE_FUTURE'))
  v.retrievedAt = '2026-01-01'
  assert.ok(codes(validateVendor(v, NOW)).includes('warning:STALE'))
})

test('a per-1M-characters price must name its tier and must not be a unit conversion', () => {
  const v = structuredClone(fixtureLibrary().vendors[1])
  v.pricing.tiers[2].pricePer1MCharsUsd = 30
  assert.ok(codes(validateVendor(v, NOW)).includes('error:PRICE_UNIT_CONVERSION'))
  v.pricing.tiers[2].notes = 'The vendor states that one minute is about 900 characters (conversion on its pricing page)'
  assert.ok(!codes(validateVendor(v, NOW)).includes('error:PRICE_UNIT_CONVERSION'))
  const w = structuredClone(fixtureLibrary().vendors[0])
  w.pricing.tiers = []
  w.pricing.headlineTier = ''
  assert.ok(codes(validateVendor(w, NOW)).includes('error:PRICE_NO_TIER'))
})

test('banned words: superlatives, disparagement, unverifiable promises and quality or benchmark claims', () => {
  for (const t of ['the best voices', 'it is the only option', 'cheaper than most', 'sounds better than', 'a natural-sounding voice', 'a benchmark of voices', 'MOS score of 4', 'always works', 'poor support', 'a guarantee']) assert.ok(findBanned(t, BANNED_STRICT).length > 0, t)
  assert.equal(findBanned('English-only voices', BANNED_STRICT).length, 0)
  assert.equal(findBanned('the mos of it', BANNED_STRICT).length, 0, 'acronym MOS matches case-sensitively')
  assert.equal(findBanned('Best Voice Inc offers speech', BANNED_STRICT, ['Best Voice Inc']).length, 0)
  assert.ok(findBanned('a lifelike voice', BANNED_LITE).length > 0, 'quality claims are banned on use-case pages too')
  assert.equal(findBanned('best practice for scripts', BANNED_LITE).length, 0)
})

test('a banned word in researcher text fails the vendor page', () => {
  const lib = withVendor(fixtureLibrary(), 'elevenlabs', (v) => { v.strengths[0].claim = 'The best and most natural voices' })
  const r = run(lib)
  assert.ok(r.errors.some((e) => e.code === 'BANNED_WORD' && e.where.includes('elevenlabs')))
})

test('certification wording: none for ReadAloud, none for a vendor unless its data says stated', () => {
  assert.equal(findCertClaims('ReadAloud is HIPAA compliant.')[0].raSubject, true)
  assert.equal(findCertClaims('ReadAloud does not claim HIPAA compliance.').length, 0)
  assert.equal(findCertClaims('You may need to be HIPAA compliant.').length, 0)
  const lib = withVendor(fixtureLibrary(), 'openai-tts', (v) => { v.strengths[0].claim = 'Offers HIPAA compliant processing' })
  assert.ok(run(lib).errors.some((e) => e.code === 'CERT_CLAIM_VENDOR'), 'hipaa is not-stated for this vendor')
  const lib2 = withVendor(fixtureLibrary(), 'elevenlabs', (v) => { v.strengths[0].claim = 'Is SOC 2 certified' })
  assert.ok(!run(lib2).errors.some((e) => e.code.startsWith('CERT_CLAIM')), 'soc2 is stated for this vendor')
  const lib3 = fixtureLibrary()
  lib3.useCases[0].considerations[0] = 'ReadAloud is SOC 2 certified'
  assert.ok(run(lib3).errors.some((e) => e.code === 'CERT_CLAIM'))
})

test('ReadAloud engine names are an error on use-case and integration pages, a warning on vendor pages', () => {
  const lib = fixtureLibrary()
  lib.useCases[0].considerations[0] = 'The voice is made by Piper'
  assert.ok(run(lib).errors.some((e) => e.code === 'ENGINE_NAME'))
  const lib2 = withVendor(fixtureLibrary(), 'openai-tts', (v) => { v.strengths[0].claim = 'Hosts Kokoro models' })
  const r = run(lib2)
  assert.ok(!r.errors.some((e) => e.code === 'ENGINE_NAME'))
  assert.ok(r.warnings.some((e) => e.code === 'ENGINE_NAME'))
})

test('a vendor that is lower per character than a ReadAloud tier is said to be lower, plainly', () => {
  const lib = withVendor(fixtureLibrary(), 'elevenlabs', (v) => {
    v.pricing.tiers = [{ name: 'Budget', pricePer1MCharsUsd: 2, unit: '1M characters', notes: '' }, { name: 'Mid', pricePer1MCharsUsd: 8, unit: '1M characters', notes: '' }]
    v.pricing.pricePer1MCharsUsd = 2
    v.pricing.headlineTier = 'Budget'
  })
  const pages = buildPages(lib).filter((p) => p.vendorSlug === 'elevenlabs')
  assert.ok(pages.length >= 2)
  const compare = pages.find((p) => p.type === 'compare')!
  const text = JSON.stringify(compare.blocks)
  assert.match(text, /is lower than ReadAloud Live/)
  assert.match(text, /lower than ReadAloud Studio/)
  assert.deepEqual(run(lib).errors, [])
  // and the gate catches a template that forgets to say it
  const stripped = { ...compare, blocks: compare.blocks.filter((b) => !(b.kind === 'p' && /lower than/.test(b.text))) }
  assert.ok(validatePage(lib, stripped).some((i) => i.code === 'PRICE_ADVANTAGE_UNSTATED'))
})

test('a vendor that prices in other units is shown in its own unit and never converted', () => {
  const lib = fixtureLibrary()
  const p = buildPages(lib).find((x) => x.path === '/compare/readaloud-vs-openai-tts')!
  const text = JSON.stringify(p.blocks)
  assert.match(text, /per minute of audio; not converted/)
  assert.match(text, /Not comparable/)
  const none = withVendor(lib, 'openai-tts', (v) => { v.pricing.pricePer1MCharsUsd = null; v.pricing.tiers = v.pricing.tiers.map((t) => ({ ...t, pricePer1MCharsUsd: null, unit: 'per minute of audio' })) })
  const q = buildPages(none).find((x) => x.path === '/compare/readaloud-vs-openai-tts')!
  assert.match(JSON.stringify(q.blocks), /does not list a price per character/)
})

test('thin pages fail', () => {
  const lib = fixtureLibrary()
  const p = buildPages(lib).find((x) => x.type === 'compare')!
  const thin = { ...p, blocks: p.blocks.slice(0, 4) }
  assert.ok(validatePage(lib, thin).some((i) => i.code === 'THIN_PAGE'))
  lib.useCases[0].intro = 'Too short.'
  assert.ok(run(lib).errors.some((e) => e.code === 'INTRO_SHORT'))
})

test('vendor pages need the disclaimer, the corrections address, a verified date, sources and the disclosure, and carry no FAQ markup', () => {
  const lib = fixtureLibrary()
  const p = buildPages(lib).find((x) => x.type === 'compare')!
  const bad = { ...p, lastVerified: undefined, blocks: p.blocks.filter((b) => b.kind !== 'sources' && b.kind !== 'verified' && !(b.kind === 'p' && /may have changed/.test(b.text))), faqJsonLd: [{ q: 'a', a: 'b' }] }
  const c = codes(validatePage(lib, bad))
  for (const x of ['NO_VERIFIED_DATE', 'NO_DISCLAIMER', 'NO_SOURCES', 'FAQ_ON_VENDOR_PAGE']) assert.ok(c.includes(`error:${x}`), x)
  for (const t of ['compare', 'alternatives', 'migrate'] as const) {
    const pg = buildPages(lib).find((x) => x.type === t)!
    const txt = JSON.stringify(pg.blocks)
    assert.match(txt, /support@readaloudai\.org/)
    assert.match(txt, /may have changed them since/)
    assert.match(txt, /We make ReadAloud/)
    assert.ok(!pg.faqJsonLd)
  }
})

test('use-case and integration count rules', () => {
  const lib = fixtureLibrary()
  lib.useCases[0].steps = ['a', 'b']
  lib.useCases[0].faq = lib.useCases[0].faq.slice(0, 2)
  lib.useCases[0].relatedSlugs = ['x']
  lib.useCases[0].whenToChooseSomethingElse = []
  lib.useCases[0].sampleExample.input = 'x'.repeat(5001)
  lib.integrations[0].quickstart.code = `client = Client(api_key="${'rtts_'}${'a'.repeat(20)}")`
  lib.integrations[0].verifiedWith.date = '2026-12-31'
  const c = codes(run(lib).issues)
  for (const x of ['STEPS_COUNT', 'FAQ_COUNT', 'RELATED_COUNT', 'NOT_BALANCED', 'EXAMPLE_TOO_LONG', 'CODE_HAS_SECRET', 'DATE_FUTURE']) assert.ok(c.includes(`error:${x}`), x)
})

test('related slugs must resolve when checked', () => {
  const lib = fixtureLibrary()
  lib.useCases[1].relatedSlugs[0] = 'ghost'
  const r = validateLibrary(lib, NOW)
  assert.ok(r.errors.some((e) => e.code === 'RELATED_MISSING'))
  assert.ok(r.errors.some((e) => e.code === 'RELATED_SELF'), 'the voice-agents fixture lists itself')
})

test('duplicate paths and titles are errors', () => {
  const lib = fixtureLibrary()
  lib.vendors.push({ ...structuredClone(lib.vendors[0]), slug: 'elevenlabs', name: 'ElevenLabs' })
  assert.ok(run(lib).errors.some((e) => e.code === 'DUPLICATE_PATH'))
})

test('near-duplicate pages fail the similarity gate', () => {
  const lib = fixtureLibrary()
  const clone = structuredClone(lib.vendors[0])
  clone.slug = 'elevenlabs-copy'
  clone.name = 'ElevenLabs Copy'
  lib.vendors.push(clone)
  const r = run(lib)
  assert.ok(r.errors.some((e) => e.code === 'TOO_SIMILAR' || e.code === 'LOW_UNIQUE_SHARE'))
})

test('publish.json entries must match a page; a published page with errors fails', () => {
  assert.ok(run(fixtureLibrary(['nonsense'])).errors.some((e) => e.code === 'PUBLISH_UNKNOWN'))
  assert.ok(!run(fixtureLibrary(['elevenlabs', 'compare:openai-tts', 'migrate:elevenlabs'])).errors.some((e) => e.code === 'PUBLISH_UNKNOWN'))
  const lib = withVendor(fixtureLibrary(['elevenlabs']), 'elevenlabs', (v) => { v.strengths[0].claim = 'The best voices' })
  assert.ok(run(lib).errors.some((e) => e.code === 'PUBLISHED_PAGE_HAS_ERRORS'))
})

test('SCALE: 20 synthetic vendors, 12 migration pages, no hard errors, every pair under the overlap ceiling, typical unique share above the aim', () => {
  // The synthetic vendors have lean data (4 strengths, 3 limitations, a few tiers), so this is a stress test of the template share, not
  // a forecast: real researched vendors carry more text. A page under SIMILARITY.minUniqueShare is a build error once published.
  const base = fixtureLibrary()
  const lib: Library = { ...base, vendors: syntheticVendors(base.vendors[0], 20), publish: { published: [] } }
  const r = run(lib)
  const counts = (t: string) => r.pages.filter((p) => p.type === t).length
  assert.equal(counts('compare'), 20)
  assert.equal(counts('alternatives'), 20)
  assert.equal(counts('migrate'), 12)
  const hard = r.errors.filter((e) => !['RELATED_MISSING', 'RELATED_COUNT', 'LOW_UNIQUE_SHARE', 'TOO_SIMILAR'].includes(e.code))
  assert.deepEqual(hard, [], hard.map((e) => `${e.code} ${e.where} ${e.message}`).join('\n'))
  const summary: Record<string, unknown> = {}
  for (const t of ['compare', 'alternatives', 'migrate']) {
    const rep = r.similarity[t]
    const shares = rep.unique.map((u) => u.share).sort((a, b) => a - b)
    const median = shares[Math.floor(shares.length / 2)]
    summary[t] = { maxPair: +rep.maxJaccard.toFixed(2), minUnique: +rep.minUnique.toFixed(2), medianUnique: +median.toFixed(2) }
    assert.ok(rep.maxJaccard <= SIMILARITY.maxPairJaccard + 0.06, `${t} max pair overlap ${rep.maxJaccard}`)
    assert.ok(median >= SIMILARITY.minUniqueShare, `${t} median unique share ${median}`)
    assert.ok(rep.minUnique >= 0.3, `${t} min unique share ${rep.minUnique}`)
  }
  console.log('scale similarity (synthetic, lean data):', JSON.stringify(summary))
  // the gate itself still bites: a failing page is reported with the right code
  assert.ok(r.issues.every((i) => i.code !== 'LOW_UNIQUE_SHARE' || i.severity === 'error' || i.severity === 'warning'))
})

test('migration pages: capped at 12, priority order, hand-written elevenlabs page is not duplicated', () => {
  const base = fixtureLibrary()
  const lib: Library = { ...base, vendors: [...base.vendors, ...syntheticVendors(base.vendors[0], 20)] }
  const pages = buildPages(lib).filter((p) => p.type === 'migrate').map((p) => p.slug)
  assert.ok(!pages.includes('elevenlabs'))
  assert.equal(pages[0], 'openai-tts')
  assert.equal(pages.length, 11) // 12 slots, one of them the hand-written ElevenLabs page
})
