import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLibraryForTests, allPages, pagesOfType, publishedPages, hubChildren, hubModel, findPage, pageIsPublished, resetLibraryCache } from '../../src/lib/seoLibrary/index.ts'
import { sitemapEntries, CORE_PATHS } from '../../src/lib/seoLibrary/sitemapEntries.ts'
import { metadataFor, breadcrumbJsonLd, faqJsonLd, jsonLdString } from '../../src/lib/seoLibrary/seo.ts'
import { isPublished, publishKey } from '../../src/lib/seoLibrary/publish.ts'
import { slugFromSegment, paths } from '../../src/lib/seoLibrary/routes.ts'
import { fixtureLibrary } from './helpers.ts'

const urls = () => sitemapEntries().map((e) => e.url)

test('nothing published: pages exist but are noindex, out of the sitemap and hubs', () => {
  setLibraryForTests(fixtureLibrary(), { checkRelated: false })
  assert.equal(allPages().length, 9)
  assert.equal(publishedPages().length, 0)
  assert.ok(urls().every((u) => !/^https:\/\/readaloudai\.org\/(compare|alternatives|migrate|integrations|use-cases)/.test(u)), 'only core pages')
  assert.equal(urls().length, CORE_PATHS.length)
  const p = findPage('compare', 'readaloud-vs-elevenlabs')!
  assert.equal(pageIsPublished(p), false)
  assert.deepEqual(metadataFor(p, false).robots, { index: false })
  assert.equal(hubModel('compare').indexed, false)
  resetLibraryCache()
})

test('a published wave appears in the sitemap and hubs, indexable, with a canonical URL', () => {
  setLibraryForTests(fixtureLibrary(['elevenlabs', 'integrations:pipecat']), { checkRelated: false })
  const u = urls()
  assert.ok(u.includes('https://readaloudai.org/compare/readaloud-vs-elevenlabs'))
  assert.ok(u.includes('https://readaloudai.org/alternatives/elevenlabs-alternatives'))
  assert.ok(u.includes('https://readaloudai.org/integrations/pipecat'))
  assert.ok(u.includes('https://readaloudai.org/compare'))
  assert.ok(!u.some((x) => x.includes('openai-tts')))
  assert.ok(!u.some((x) => x.includes('/migrate/from-elevenlabs')), 'never generated')
  assert.equal(hubChildren('compare').length, 1)
  assert.equal(hubModel('compare').indexed, true)
  assert.equal(hubModel('use-cases').indexed, false)
  const p = findPage('compare', 'readaloud-vs-elevenlabs')!
  const m = metadataFor(p, true)
  assert.equal(m.robots, undefined)
  assert.equal(m.alternates?.canonical, 'https://readaloudai.org/compare/readaloud-vs-elevenlabs')
  resetLibraryCache()
})

test('every library URL in the sitemap is unique and absolute', () => {
  setLibraryForTests(fixtureLibrary(['elevenlabs', 'openai-tts', 'pipecat', 'openai-sdk', 'voice-agents', 'audio-articles']), { checkRelated: false })
  const u = urls()
  assert.equal(new Set(u).size, u.length)
  assert.ok(u.every((x) => x.startsWith('https://readaloudai.org')))
  assert.equal(pagesOfType('use-case').length, 2)
  resetLibraryCache()
})

test('publish keys and slug segments', () => {
  const list = { published: ['elevenlabs', 'compare:openai-tts'] }
  assert.ok(isPublished(list, 'migrate', 'elevenlabs'))
  assert.ok(isPublished(list, 'compare', 'openai-tts'))
  assert.ok(!isPublished(list, 'alternatives', 'openai-tts'))
  assert.equal(publishKey('integration', 'pipecat'), 'integrations:pipecat')
  assert.equal(slugFromSegment('compare', 'readaloud-vs-elevenlabs'), 'elevenlabs')
  assert.equal(slugFromSegment('alternatives', 'openai-tts-alternatives'), 'openai-tts')
  assert.equal(slugFromSegment('migrate', 'from-lmnt'), 'lmnt')
  assert.equal(slugFromSegment('compare', 'elevenlabs'), null)
  assert.equal(paths.migrate('lmnt'), '/migrate/from-lmnt')
})

test('JSON-LD: breadcrumbs, FAQ and script-safe escaping', () => {
  const b = breadcrumbJsonLd([{ name: 'Home', path: '/' }, { name: 'Compare', path: '/compare' }])
  assert.equal(b['@type'], 'BreadcrumbList')
  assert.equal(b.itemListElement[1].item, 'https://readaloudai.org/compare')
  assert.equal(b.itemListElement[0].item, 'https://readaloudai.org')
  assert.equal(faqJsonLd([{ q: 'Q', a: 'A' }]).mainEntity[0].acceptedAnswer.text, 'A')
  assert.ok(!jsonLdString({ x: '</script><b>' }).includes('<'))
})

test('FAQ markup only on use-case and integration pages', () => {
  setLibraryForTests(fixtureLibrary(), { checkRelated: false })
  for (const p of allPages()) assert.equal(!!p.faqJsonLd, p.type === 'use-case' || p.type === 'integration', p.path)
  resetLibraryCache()
})
