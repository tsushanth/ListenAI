import { RA_CERTIFICATION_ALLOW_LIST, RA_FEATURE_VOCABULARY, RA_FORBIDDEN_ENGINE_NAMES, RA_LIMITS, RA_SUPPORT_EMAIL } from '../../content/readaloudFacts.ts'
import type { Library } from './load.ts'
import type { Integration, UseCase, Vendor } from './schema.ts'
import { isVendorType, type LibraryPageModel, type PageType } from './model.ts'
import { buildPages, hubModels } from './pages.ts'
import { migrationVendors, numericRows, relation } from './vendor.ts'
import { isPublished, publishKey } from './publish.ts'
import { BANNED_LITE, BANNED_STRICT, findBanned } from './banned.ts'
import { findCertClaims, type CertKey } from './certs.ts'
import { SIMILARITY, similarityReport } from './similarity.ts'
import { textOfPage, wordCount } from './text.ts'
import { HAND_WRITTEN_MIGRATIONS, MIGRATE_CAP } from './routes.ts'
import { RA_LIVE, RA_STUDIO } from '../../content/readaloudFacts.ts'

// The quality gate. validateLibrary() returns every problem it finds; test/seoLibrary/realContent.test.ts fails on any 'error' in the
// real content once it exists, and src/lib/seoLibrary/index.ts refuses to build when a PUBLISHED page has one. Rules (all numbers live
// in LIMITS or SIMILARITY so they are documented in one place):
//
//  data      every vendor fact has a sourceUrl that is listed in sources[] (which carries its retrievedAt); dates are real and not in the
//            future; a per-1M-characters price names its tier and is not a unit conversion; filename = slug (load.ts)
//  pages     title, description, h1, path present; no two pages share a title, a description or a path; minimum word count per type
//            (code blocks do not count)
//  wording   no superlative, disparaging, unverifiable or quality/benchmark word on vendor pages (banned.ts); a lighter list plus the
//            quality words on use-case and integration pages; no ReadAloud engine name on use-case or integration pages (warning on vendor pages)
//  certs     no certification statement for ReadAloud (allow-list in readaloudFacts.ts, empty) or for a vendor unless its data says 'stated'
//  price     where a vendor's per-character list price is below a ReadAloud tier, the page says "lower than <tier>" plainly
//  similar   pages of one type: pairwise 5-word-shingle Jaccard <= SIMILARITY.maxPairJaccard, unique share >= SIMILARITY.minUniqueShare
//  seo       vendor pages carry last-verified, sources, the corrections address, the disclaimer, and never FAQ markup
//  links     related slugs resolve; publish.json entries match real pages; every internal link points at a page that exists

export type Severity = 'error' | 'warning'
export type Issue = { severity: Severity; code: string; where: string; message: string; key?: string }

export const LIMITS = {
  minWords: { compare: 500, alternatives: 450, migrate: 400, integration: 450, 'use-case': 600 } as Record<PageType, number>,
  introMinWords: 150,
  titleMax: 70,
  descriptionMin: 70,
  descriptionMax: 165,
  contentDescriptionMin: 120,
  contentDescriptionMax: 155,
  h1Max: 70,
  staleAfterDays: 90,
  useCase: { steps: [5, 7], faq: 5, considerations: [2, 4], related: 4 },
  integration: { faq: 4, related: 3 },
}

const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase()
const today = (now: Date) => now.toISOString().slice(0, 10)

export function validateVendor(v: Vendor, now: Date = new Date()): Issue[] {
  const issues: Issue[] = []
  const w = `vendors/${v.slug}`
  const err = (code: string, message: string) => issues.push({ severity: 'error', code, where: w, message })
  const warn = (code: string, message: string) => issues.push({ severity: 'warning', code, where: w, message })
  const t = today(now)
  const listed = new Map(v.sources.map((s) => [norm(s.url), s]))

  if (v.retrievedAt > t) err('DATE_FUTURE', `retrievedAt ${v.retrievedAt} is in the future`)
  for (const s of v.sources) if (s.retrievedAt > t) err('DATE_FUTURE', `source ${s.url} retrievedAt ${s.retrievedAt} is in the future`)
  const ageDays = Math.floor((now.getTime() - Date.parse(`${v.retrievedAt}T00:00:00Z`)) / 86_400_000)
  if (ageDays > LIMITS.staleAfterDays) warn('STALE', `retrievedAt is ${ageDays} days old (limit ${LIMITS.staleAfterDays}); re-verify before publishing`)

  const needSource = (what: string, url: string | undefined) => {
    if (!url) return err('FACT_NO_SOURCE', `${what} has no sourceUrl`)
    if (!listed.has(norm(url))) err('FACT_SOURCE_NOT_LISTED', `${what} cites ${url}, which is not in sources[] (sources[] carries the retrievedAt)`)
  }
  const stated = (s: string) => !!s && !/^(not stated|unknown|n\/a|none)\b/i.test(s.trim())

  if (v.pricing.sourceUrls.length === 0) err('FACT_NO_SOURCE', 'pricing has no sourceUrls')
  v.pricing.sourceUrls.forEach((u) => needSource('pricing', u))
  if (stated(v.voices.count) || stated(v.voices.languages) || stated(v.voices.customVoiceOrCloning) || v.voices.sourceUrl) needSource('voices', v.voices.sourceUrl)
  if (stated(v.streaming.vendorStatedLatency) || v.streaming.websocket !== 'unknown' || v.streaming.http !== 'unknown' || v.streaming.sourceUrl) needSource('streaming', v.streaming.sourceUrl)
  if (stated(v.licensing.commercialUse) || stated(v.licensing.attributionOrConditions) || v.licensing.sourceUrl) needSource('licensing', v.licensing.sourceUrl)
  if (stated(v.limits.perRequestCharacters) || stated(v.limits.concurrency) || v.limits.sourceUrl) needSource('limits', v.limits.sourceUrl)
  // When hipaa, soc2 and gdpr are all 'not-stated' there is no compliance fact to cite. Any 'stated' value still needs a listed source.
  if ([v.compliance.hipaa, v.compliance.soc2, v.compliance.gdpr].some((x) => x !== 'not-stated') || v.compliance.sourceUrl) needSource('compliance', v.compliance.sourceUrl)
  if (v.migration.stepsToMove.length && v.migration.sourceUrls.length === 0) err('FACT_NO_SOURCE', 'migration.stepsToMove has no sourceUrls')
  v.migration.sourceUrls.forEach((u) => needSource('migration', u))
  v.strengths.forEach((s, i) => needSource(`strengths[${i}]`, s.sourceUrl))
  v.limitations.forEach((s, i) => needSource(`limitations[${i}]`, s.sourceUrl))
  for (const s of v.sources) if (!/^https:/i.test(s.url)) warn('SOURCE_NOT_HTTPS', `${s.url} is not https`)

  // Prices: a per-1M-characters price must say what tier it covers, and must not be a conversion from another unit.
  if (v.pricing.pricePer1MCharsUsd !== null && !v.pricing.headlineTier && v.pricing.tiers.length === 0) err('PRICE_NO_TIER', 'pricePer1MCharsUsd is set but headlineTier and tiers[] are empty, so the page cannot say what tier the price covers')
  if (v.pricing.pricePer1MCharsUsd !== null && v.pricing.headlineTier && v.pricing.tiers.length > 0 && !v.pricing.tiers.some((x) => x.name.toLowerCase() === v.pricing.headlineTier.toLowerCase())) warn('PRICE_HEADLINE_TIER_UNLISTED', `headlineTier "${v.pricing.headlineTier}" matches no tiers[].name`)
  v.pricing.tiers.forEach((tier, i) => {
    if (tier.pricePer1MCharsUsd === null) return
    const unit = `${tier.unit}`.toLowerCase()
    const converts = /minute|hour|second|token|credit|seat|month|word|audio/.test(unit) && !/char|million|1m/.test(unit)
    if (converts && !/convert|conversion|equivalent|states that/i.test(tier.notes)) err('PRICE_UNIT_CONVERSION', `tiers[${i}] "${tier.name}" has a per-1M-characters price but its unit is "${tier.unit}"; do not convert units unless the vendor states the conversion (say so in notes)`)
  })
  if (v.pricing.pricePer1MCharsUsd === null && v.pricing.tiers.every((x) => x.pricePer1MCharsUsd === null) && !stated(v.pricing.headline)) warn('PRICE_NO_HEADLINE', 'no per-character price and no headline text: the pricing section will be thin')

  if (v.status === 'active' && v.strengths.length < 2) warn('THIN_DATA', 'fewer than 2 strengths; the pages for this vendor will be short')
  if (v.status === 'active' && v.unknowns.length === 0) warn('NO_UNKNOWNS', 'unknowns[] is empty; confirm nothing was left unverified')
  return issues
}

const hasWords = (s: string, min: number) => wordCount(s) >= min

function validateContentData(lib: Library, checkRelated: boolean, now: Date): Issue[] {
  const issues: Issue[] = []
  const all = new Set([...lib.useCases.map((u) => u.slug), ...lib.integrations.map((i) => i.slug)])
  const mk = (kind: 'use-cases' | 'integrations', d: { slug: string }) => {
    const where = `${kind}/${d.slug}`
    const key = publishKey(kind === 'use-cases' ? 'use-case' : 'integration', d.slug)
    return {
      e: (code: string, message: string) => issues.push({ severity: 'error', code, where, message, key }),
      wn: (code: string, message: string) => issues.push({ severity: 'warning', code, where, message, key }),
    }
  }
  const common = (kind: 'use-cases' | 'integrations', d: UseCase | Integration, faqN: number, relatedN: number) => {
    const { e, wn } = mk(kind, d)
    if (!hasWords(d.intro, LIMITS.introMinWords)) e('INTRO_SHORT', `intro has ${wordCount(d.intro)} words, needs at least ${LIMITS.introMinWords}`)
    if (d.h1.length > LIMITS.h1Max) e('H1_LONG', `h1 is ${d.h1.length} characters (limit ${LIMITS.h1Max})`)
    if (d.metaDescription.length > LIMITS.contentDescriptionMax) wn('DESC_LONG', `metaDescription is ${d.metaDescription.length} characters (limit ${LIMITS.contentDescriptionMax})`)
    if (d.metaDescription.length < LIMITS.contentDescriptionMin) wn('DESC_SHORT', `metaDescription is ${d.metaDescription.length} characters (minimum ${LIMITS.contentDescriptionMin})`)
    if (d.faq.length !== faqN) e('FAQ_COUNT', `faq has ${d.faq.length} entries, expected ${faqN}`)
    if (d.relatedSlugs.length !== relatedN) e('RELATED_COUNT', `relatedSlugs has ${d.relatedSlugs.length} entries, expected ${relatedN}`)
    if (new Set(d.relatedSlugs).size !== d.relatedSlugs.length) wn('RELATED_DUPLICATE', 'relatedSlugs lists the same slug more than once')
    for (const r of d.relatedSlugs) {
      if (!checkRelated) break
      if (r === d.slug) e('RELATED_SELF', `relatedSlugs contains its own slug "${r}"`)
      else if (!all.has(r)) e('RELATED_MISSING', `relatedSlugs "${r}" matches no use case or integration`)
    }
  }
  const secret = /(rtts_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{16,}|xi-api-key["':\s=]+[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,})/
  for (const d of lib.useCases) {
    const { e, wn } = mk('use-cases', d)
    common('use-cases', d, LIMITS.useCase.faq, LIMITS.useCase.related)
    const [smin, smax] = LIMITS.useCase.steps
    if (d.steps.length < smin || d.steps.length > smax) e('STEPS_COUNT', `steps has ${d.steps.length} entries, expected ${smin} to ${smax}`)
    const [cmin, cmax] = LIMITS.useCase.considerations
    if (d.considerations.length < cmin || d.considerations.length > cmax) e('CONSIDERATIONS_COUNT', `considerations has ${d.considerations.length} entries, expected ${cmin} to ${cmax}`)
    if (d.whenToChooseReadAloud.length === 0 || d.whenToChooseSomethingElse.length === 0) e('NOT_BALANCED', 'whenToChooseReadAloud and whenToChooseSomethingElse must both have entries; a page that never says when to use something else reads as an advertisement')
    if (d.featuresUsed.length === 0) e('FEATURES_EMPTY', 'featuresUsed is empty')
    if (d.sampleExample.input.length > RA_LIMITS.perRequestCharacters) e('EXAMPLE_TOO_LONG', `sampleExample.input is ${d.sampleExample.input.length} characters; one request takes ${RA_LIMITS.perRequestCharacters}`)
    if (secret.test(d.sampleExample.input)) e('CODE_HAS_SECRET', 'sampleExample.input looks like it contains a key')
    const vocab = RA_FEATURE_VOCABULARY.map((f) => f.toLowerCase())
    for (const f of d.featuresUsed) {
      const n = f.feature.toLowerCase()
      if (!vocab.some((x) => n.includes(x) || x.includes(n))) wn('FEATURE_NOT_IN_FACTS', `feature "${f.feature}" is not in RA_FEATURE_VOCABULARY (src/content/readaloudFacts.ts); confirm ReadAloud has it`)
    }
  }
  for (const d of lib.integrations) {
    const { e, wn } = mk('integrations', d)
    common('integrations', d, LIMITS.integration.faq, LIMITS.integration.related)
    if (!d.quickstart.code.trim()) e('CODE_EMPTY', 'quickstart.code is empty')
    if (secret.test(`${d.install}\n${d.quickstart.code}`)) e('CODE_HAS_SECRET', 'install or quickstart looks like it contains a real key; use a placeholder such as YOUR_KEY')
    if (d.verifiedWith.date > today(now)) e('DATE_FUTURE', `verifiedWith.date ${d.verifiedWith.date} is in the future`)
    if (Math.floor((now.getTime() - Date.parse(`${d.verifiedWith.date}T00:00:00Z`)) / 86_400_000) > LIMITS.staleAfterDays) wn('STALE', `verifiedWith.date ${d.verifiedWith.date} is more than ${LIMITS.staleAfterDays} days old; re-run the check before publishing`)
    if (d.whatWorks.length === 0) e('NOTHING_VERIFIED', 'whatWorks is empty: an integration page must say what was checked')
    if (d.limitations.length === 0) wn('NO_LIMITATIONS', 'limitations is empty; confirm nothing is unsupported')
    for (const l of d.links) if (!/^https:/i.test(l.url)) wn('LINK_NOT_HTTPS', `${l.url} is not https`)
  }
  return issues
}

/** Every check that looks at one page on its own. Exported for tests. */
export function validatePage(lib: Library, p: LibraryPageModel): Issue[] {
  const issues: Issue[] = []
  const e = (code: string, message: string) => issues.push({ severity: 'error', code, where: p.path, message, key: p.key })
  const wn = (code: string, message: string) => issues.push({ severity: 'warning', code, where: p.path, message, key: p.key })
  for (const f of ['title', 'description', 'h1', 'lede', 'path'] as const) if (!p[f] || !p[f].trim()) e('MISSING_FIELD', `${f} is empty`)
  if (p.blocks.length === 0) e('MISSING_FIELD', 'page has no body')
  if (p.title.length > LIMITS.titleMax) wn('TITLE_LONG', `title is ${p.title.length} characters (limit ${LIMITS.titleMax})`)
  if (p.description.length > LIMITS.descriptionMax) wn('DESC_LONG', `description is ${p.description.length} characters (limit ${LIMITS.descriptionMax})`)

  const body = textOfPage(p, { skip: ['sources', 'code'] })
  const everything = textOfPage(p, { skip: ['sources'] })
  const words = wordCount(body)
  if (words < LIMITS.minWords[p.type]) e('THIN_PAGE', `${words} words; ${p.type} pages need at least ${LIMITS.minWords[p.type]} (thin pages risk being treated as spam; code does not count)`)

  const strict = isVendorType(p.type)
  const allowNames = [p.vendorName ?? '']
  for (const h of findBanned(`${p.title}\n${p.description}\n${body}`, strict ? BANNED_STRICT : BANNED_LITE, allowNames)) e('BANNED_WORD', `"${h.term}" in: ...${h.context}...`)

  for (const h of findBanned(`${p.title}\n${p.description}\n${everything}`, RA_FORBIDDEN_ENGINE_NAMES, allowNames)) {
    if (strict) wn('ENGINE_NAME', `"${h.term}" in: ...${h.context}... (fine if it is the vendor's own model; never ReadAloud's engines)`)
    else e('ENGINE_NAME', `"${h.term}" in: ...${h.context}... (pages must say ReadAloud Live or ReadAloud Studio, never the engines behind them)`)
  }

  const vendor = p.vendorSlug ? lib.vendors.find((c) => c.slug === p.vendorSlug) : undefined
  for (const claim of findCertClaims(`${p.title}\n${p.description}\n${body}`)) {
    if (strict && !claim.raSubject && vendor) {
      const k = claim.cert as CertKey
      const stated = k === 'hipaa' || k === 'soc2' || k === 'gdpr' ? vendor.compliance[k] === 'stated' : new RegExp(k === 'iso27001' ? 'ISO' : k, 'i').test(vendor.compliance.note)
      if (!stated) e('CERT_CLAIM_VENDOR', `${vendor.name} is described with ${claim.cert.toUpperCase()} but its data does not say 'stated': "${claim.sentence}"`)
    } else if (!RA_CERTIFICATION_ALLOW_LIST.includes(claim.cert)) {
      e('CERT_CLAIM', `certification wording not allowed (${claim.cert.toUpperCase()}; the ReadAloud allow-list is [${RA_CERTIFICATION_ALLOW_LIST.join(', ')}]): "${claim.sentence}"`)
    }
  }

  if (strict) {
    if (!p.lastVerified) e('NO_VERIFIED_DATE', 'vendor page has no last-verified date')
    if (!body.includes(RA_SUPPORT_EMAIL)) e('NO_CORRECTIONS', `page does not carry the corrections address ${RA_SUPPORT_EMAIL}`)
    if (!/may have changed them since/i.test(body)) e('NO_DISCLAIMER', 'page does not carry the public-pages disclaimer')
    if (!/we make ReadAloud/i.test(body)) e('NO_DISCLOSURE', 'page does not say that we make ReadAloud')
    if (!p.blocks.some((b) => b.kind === 'sources' && b.items.length > 0)) e('NO_SOURCES', 'vendor page lists no sources')
    if (p.faqJsonLd || p.blocks.some((b) => b.kind === 'faq')) e('FAQ_ON_VENDOR_PAGE', 'vendor pages must not carry FAQ markup')
    if (vendor) {
      const lowerLive = numericRows(vendor).some((r) => relation(r.per1M, RA_LIVE.per1MUsd) === 'lower')
      const lowerStudio = numericRows(vendor).some((r) => relation(r.per1M, RA_STUDIO.per1MUsd) === 'lower')
      if (lowerLive && !/(?:is|are) lower than ReadAloud Live/.test(body)) e('PRICE_ADVANTAGE_UNSTATED', `${vendor.name} is lower per character than ReadAloud Live but the page does not say so plainly ("is lower than ReadAloud Live")`)
      if (lowerStudio && !/(?:is|are) lower than ReadAloud Studio/.test(body)) e('PRICE_ADVANTAGE_UNSTATED', `${vendor.name} is lower per character than ReadAloud Studio but the page does not say so plainly ("is lower than ReadAloud Studio")`)
    }
  } else {
    if (!p.faqJsonLd || p.faqJsonLd.length === 0) wn('NO_FAQ', 'content page has no FAQ')
  }
  for (const b of p.blocks) {
    if (b.kind === 'table') for (const r of b.rows) for (const c of r) if (!c.text.trim()) e('EMPTY_CELL', `table row "${r[0]?.text}" has an empty cell (omit rows where either side is unknown)`)
  }
  return issues
}

export type ValidationResult = {
  issues: Issue[]
  errors: Issue[]
  warnings: Issue[]
  pages: LibraryPageModel[]
  similarity: Record<string, ReturnType<typeof similarityReport>>
}

const SIMILARITY_GROUPS: PageType[] = ['compare', 'alternatives', 'migrate', 'integration', 'use-case']

/**
 * `checkRelated: false` skips the check that relatedSlugs name real pages. Only the test fixtures (a handful of content pages) use it,
 * because four related slugs cannot all resolve in a library that small.
 */
export function validateLibrary(lib: Library, now: Date = new Date(), opts: { checkRelated?: boolean } = {}): ValidationResult {
  const issues: Issue[] = []
  const pages = buildPages(lib)

  for (const v of lib.vendors) issues.push(...validateVendor(v, now))
  issues.push(...validateContentData(lib, opts.checkRelated !== false, now))
  for (const p of pages) issues.push(...validatePage(lib, p))

  // uniqueness across every page and hub
  const hubs = Object.values(hubModels())
  const seen = { title: new Map<string, string>(), description: new Map<string, string>(), path: new Map<string, string>() }
  for (const p of [...pages, ...hubs]) {
    const id = p.path
    for (const f of ['title', 'description', 'path'] as const) {
      const v = p[f].trim().toLowerCase()
      const prev = seen[f].get(v)
      if (prev) issues.push({ severity: 'error', code: `DUPLICATE_${f.toUpperCase()}`, where: id, message: `${f} duplicates ${prev}: "${p[f]}"`, key: 'key' in p ? p.key : undefined })
      else seen[f].set(v, id)
    }
  }

  // similarity within a page type. Code blocks and the sources list are left out: code cannot pad a page, and sources are data.
  const similarity: ValidationResult['similarity'] = {}
  for (const type of SIMILARITY_GROUPS) {
    const group = pages.filter((p) => p.type === type)
    if (group.length < 2) continue
    const rep = similarityReport(group.map((p) => ({ id: p.path, text: textOfPage(p, { skip: ['sources', 'code'] }) })))
    similarity[type] = rep
    for (const pr of rep.pairs) {
      const key = group.find((g) => g.path === pr.a)?.key
      if (pr.jaccard > SIMILARITY.maxPairJaccard) issues.push({ severity: 'error', code: 'TOO_SIMILAR', where: pr.a, message: `${(pr.jaccard * 100).toFixed(0)}% shingle overlap with ${pr.b} (limit ${SIMILARITY.maxPairJaccard * 100}%)`, key })
      else if (pr.jaccard > SIMILARITY.warnPairJaccard) issues.push({ severity: 'warning', code: 'SIMILAR', where: pr.a, message: `${(pr.jaccard * 100).toFixed(0)}% shingle overlap with ${pr.b}` })
    }
    for (const u of rep.unique) {
      const key = group.find((g) => g.path === u.id)?.key
      if (u.share < SIMILARITY.minUniqueShare) issues.push({ severity: 'error', code: 'LOW_UNIQUE_SHARE', where: u.id, message: `only ${(u.share * 100).toFixed(0)}% of its text is unique among ${type} pages (minimum ${SIMILARITY.minUniqueShare * 100}%)`, key })
      else if (u.share < SIMILARITY.warnUniqueShare) issues.push({ severity: 'warning', code: 'LOW_UNIQUE_SHARE', where: u.id, message: `${(u.share * 100).toFixed(0)}% unique among ${type} pages (aim for ${SIMILARITY.warnUniqueShare * 100}%)` })
    }
  }

  // alternatives need other options from the dataset
  const active = lib.vendors.filter((c) => c.status === 'active')
  const need = Math.min(2, active.length - 1)
  for (const p of pages.filter((x) => x.type === 'alternatives')) {
    const cards = p.blocks.find((b) => b.kind === 'cards')
    const n = cards && cards.kind === 'cards' ? cards.items.length - 1 : 0
    if (n < need) issues.push({ severity: 'error', code: 'ALTERNATIVES_TOO_FEW', where: p.path, message: `lists ${n} other alternatives, needs ${need}`, key: p.key })
  }

  // migration cap (including slots taken by hand-written pages)
  if (migrationVendors(lib).length > MIGRATE_CAP) issues.push({ severity: 'error', code: 'MIGRATE_CAP', where: '/migrate', message: `more than ${MIGRATE_CAP} migration pages` })

  // publish.json entries must name something that exists, and a published page must be clean
  const keys = new Set(pages.map((p) => p.key))
  const slugs = new Set(pages.map((p) => p.slug))
  const handWritten = new Set(Object.keys(HAND_WRITTEN_MIGRATIONS))
  for (const entry of lib.publish.published) {
    if (!keys.has(entry) && !slugs.has(entry) && !handWritten.has(entry) && !Array.from(handWritten).some((h) => entry === `migrate:${h}`)) issues.push({ severity: 'error', code: 'PUBLISH_UNKNOWN', where: 'publish.json', message: `"${entry}" matches no page` })
  }
  const publishedWithErrors = new Set(issues.filter((i) => i.severity === 'error' && i.key && isPublished(lib.publish, keyType(i.key), keySlug(i.key))).map((i) => i.key))
  for (const k of Array.from(publishedWithErrors)) issues.push({ severity: 'error', code: 'PUBLISHED_PAGE_HAS_ERRORS', where: k!, message: 'this page is published but has validation errors above' })

  // every internal link on every page points at a page that exists
  const hand = Object.values(HAND_WRITTEN_MIGRATIONS).map((h) => h.href)
  const known = new Set<string>(['/', '/developers', '/developers/mcp', '/developers#get-started', ...hand, ...pages.map((p) => p.path), ...hubs.map((h) => h.path)])
  for (const p of pages) for (const b of p.blocks) if (b.kind === 'links') for (const l of b.items) if (!l.external && !known.has(l.href)) issues.push({ severity: 'error', code: 'LINK_BROKEN', where: p.path, message: `links to ${l.href}, which is not a page`, key: p.key })

  return { issues, errors: issues.filter((i) => i.severity === 'error'), warnings: issues.filter((i) => i.severity === 'warning'), pages, similarity }
}

const KEY_TYPE: Record<string, PageType> = { compare: 'compare', alternatives: 'alternatives', migrate: 'migrate', integrations: 'integration', 'use-cases': 'use-case' }
export function keyType(key: string): PageType {
  return KEY_TYPE[key.split(':')[0]]
}
export function keySlug(key: string): string {
  return key.split(':')[1]
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `${i.severity.toUpperCase()} ${i.code} ${i.where}: ${i.message}`).join('\n')
}
