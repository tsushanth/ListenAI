import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadLibrary } from '../../src/lib/seoLibrary/load.ts'
import { validateLibrary } from '../../src/lib/seoLibrary/validate.ts'
import { isPublished } from '../../src/lib/seoLibrary/publish.ts'
import { setLibraryForTests, resetLibraryCache, publishedPages, allPages, hubChildren } from '../../src/lib/seoLibrary/index.ts'
import { sitemapEntries } from '../../src/lib/seoLibrary/sitemapEntries.ts'
import { textOfPage } from '../../src/lib/seoLibrary/text.ts'
import { findBanned } from '../../src/lib/seoLibrary/banned.ts'
import { RA_FORBIDDEN_ENGINE_NAMES } from '../../src/content/readaloudFacts.ts'

const DIR = path.join(process.cwd(), 'src', 'content')
const lib = loadLibrary(DIR)
const result = validateLibrary(lib)

const WAVE1 = [
  ...['elevenlabs', 'openai-tts', 'google-cloud-tts', 'amazon-polly', 'azure-ai-speech', 'cartesia', 'deepgram-aura'].flatMap((v) => [`compare:${v}`, `alternatives:${v}`]),
  ...['openai-tts', 'google-cloud-tts', 'amazon-polly', 'hume-octave'].map((v) => `migrate:${v}`),
  'alternatives:hume-octave',
  ...['pipecat', 'livekit-agents', 'vapi', 'n8n', 'vercel-ai-sdk', 'openai-sdk', 'elevenlabs-sdk'].map((s) => `integrations:${s}`),
  ...['voice-agents-and-ivr', 'notifications-and-alerts', 'accessibility-read-aloud-for-websites', 'article-and-newsletter-to-audio', 'e-learning-narration', 'customer-support-voice-bots'].map((s) => `use-cases:${s}`),
]

test('wave 1: publish.json lists exactly the agreed pages and every one of them exists and is clean', () => {
  assert.deepEqual([...lib.publish.published].sort(), [...WAVE1].sort())
  const keys = new Set(result.pages.map((p) => p.key))
  for (const k of WAVE1) assert.ok(keys.has(k), `${k} has no page`)
  const published = result.pages.filter((p) => isPublished(lib.publish, p.type, p.slug))
  assert.equal(published.length, WAVE1.length, 'a bare slug would publish more than the agreed list')
  assert.deepEqual(result.errors.filter((e) => e.key && WAVE1.includes(e.key)), [])
})

test('vendor status: inactive and sunsetting vendors', () => {
  const status = (s: string) => lib.vendors.find((v) => v.slug === s)!
  for (const s of ['play-ai', 'lmnt', 'resemble-ai']) {
    assert.equal(status(s).status, 'inactive', s)
    assert.ok(status(s).statusNote.length > 40, `${s} needs a documented reason`)
    assert.ok(!result.pages.some((p) => p.vendorSlug === s), `${s} must have no page at all`)
  }
  assert.equal(status('hume-octave').status, 'sunsetting')
  const humePages = result.pages.filter((p) => p.vendorSlug === 'hume-octave').map((p) => p.type).sort()
  assert.deepEqual(humePages, ['alternatives', 'migrate'], 'no compare page for a vendor that is shutting down')
  // an inactive vendor cannot be published or reached
  const bad = structuredClone(lib)
  bad.publish.published = [...bad.publish.published, 'play-ai']
  assert.ok(validateLibrary(bad).errors.some((e) => e.code === 'PUBLISH_UNKNOWN'))
})

test('hume: prominent sourced sunset notice, no prices, concrete mapping, honest note about expressive control', () => {
  const v = lib.vendors.find((x) => x.slug === 'hume-octave')!
  for (const p of result.pages.filter((x) => x.vendorSlug === 'hume-octave')) {
    const alert = p.blocks[0]
    assert.equal(alert.kind, 'alert', `${p.path} opens with the notice`)
    const text = textOfPage(p)
    assert.ok(text.includes('November 13, 2026'))
    assert.ok(text.includes(v.sunset!.notice) && text.includes(v.sunset!.dataDeletion))
    if (alert.kind === 'alert') assert.ok(alert.items.some((i) => v.sunset!.noticeSourceUrls.includes(i.sourceUrl ?? '')), 'the quotation carries its source')
    for (const price of ['$150', '$120', '$100', '$50 per', '$14', '140,000']) assert.ok(!text.includes(price), `${p.path} shows archived price text "${price}"`)
  }
  const migrate = result.pages.find((p) => p.key === 'migrate:hume-octave')!
  const mt = textOfPage(migrate)
  assert.match(mt, /does not offer emotion or expressive control/)
  assert.match(mt, /evaluate other vendors/)
  assert.match(mt, /\/v0\/tts\/stream\/input/)
  assert.match(mt, /POST \/v1\/audio\/speech/)
  assert.match(mt, /before November 13, 2026/)
})

test('elevenlabs promotions are not on any page (list prices only)', () => {
  for (const p of result.pages.filter((x) => x.vendorSlug === 'elevenlabs')) {
    const t = textOfPage(p)
    assert.ok(!/Oct(ober)? 1[28]|72% off|first month|3x credits/i.test(t), `${p.path} mentions an expiring promotion`)
  }
})

test('compare pages say plainly where a vendor is equal to or below ReadAloud on list price', () => {
  const t = (s: string) => textOfPage(result.pages.find((p) => p.key === s)!)
  assert.match(t('compare:google-cloud-tts'), /Standard voices at \$4.* match ReadAloud Live at \$4 per 1M characters/)
  assert.match(t('compare:google-cloud-tts'), /are lower than ReadAloud Studio at \$10 per 1M characters/)
  assert.match(t('compare:amazon-polly'), /Standard at \$4 matches ReadAloud Live at \$4 per 1M characters/)
  assert.match(t('compare:amazon-polly'), /is lower than ReadAloud Studio at \$10 per 1M characters/)
})

test('no wave-1 page names a ReadAloud engine, and the sitemap lists only published pages plus core pages', () => {
  for (const p of result.pages.filter((x) => isPublished(lib.publish, x.type, x.slug))) {
    assert.deepEqual(findBanned(textOfPage(p), RA_FORBIDDEN_ENGINE_NAMES), [], p.path)
  }
  setLibraryForTests(lib)
  try {
    const urls = sitemapEntries().map((e) => e.url)
    const lib2 = urls.filter((u) => /\/(compare|alternatives|migrate|integrations|use-cases)\//.test(u))
    assert.equal(lib2.length, publishedPages().length)
    for (const p of allPages()) {
      const listed = urls.includes(`https://readaloudai.org${p.path}`)
      assert.equal(listed, isPublished(lib.publish, p.type, p.slug), p.path)
    }
    for (const hub of ['compare', 'alternatives', 'migrate', 'integrations', 'use-cases'] as const) assert.ok(hubChildren(hub).length > 0, `${hub} hub has children, so it is indexable`)
    for (const s of ['play-ai', 'lmnt', 'resemble']) assert.ok(!urls.some((u) => u.includes(s)), s)
    assert.ok(!urls.some((u) => u.includes('readaloud-vs-hume')), 'no compare page for hume')
  } finally {
    resetLibraryCache()
  }
})

test('the footer Compare column is driven by publish.json, and the developers page links only published integration pages', () => {
  const footer = fs.readFileSync(path.join(process.cwd(), 'src/components/ra/RaFooter.tsx'), 'utf8')
  assert.match(footer, /LIBRARY_PUBLISHED = .*published\.length > 0/)
  const dev = fs.readFileSync(path.join(process.cwd(), 'src/app/developers/page.tsx'), 'utf8')
  assert.match(dev, /isPublished\(publish/)
  assert.match(dev, /not yet tested from a real Vapi assistant|lightly tested/)
  assert.ok(!/not <\/b>|We have <b>not<\/b> yet tested it from a real Vapi assistant/.test(dev), 'the outdated Vapi sentence is gone')
})
