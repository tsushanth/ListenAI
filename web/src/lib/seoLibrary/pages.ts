import {
  RA_API_BASE, RA_CERTIFICATION_ALLOW_LIST, RA_CLONING, RA_COMPLIANCE_STATEMENT, RA_FORMATS, RA_FREE_CREDITS, RA_LANGUAGES, RA_LATENCY, RA_LIMITS, RA_LIVE, RA_NAME, RA_OPENAI_ROUTE, RA_OTHER_PRODUCTS,
  RA_PATHS, RA_STREAMING, RA_STUDIO, RA_SUPPORT_EMAIL, RA_VOICES,
} from '../../content/readaloudFacts.ts'
import type { Integration, UseCase, Vendor } from './schema.ts'
import type { Library } from './load.ts'
import type { Block, Crumb, HubModel, LibraryPageModel, PageType } from './model.ts'
import { HAND_WRITTEN_MIGRATIONS, pathFor, paths } from './routes.ts'
import { isPublished, publishKey } from './publish.ts'
import { NOT_STATED, NOT_STATED_CAP, fitDescription, fitTitle, joinList, longDate, lowerFirst, poss, sentence, usd } from './helpers.ts'
import { CATEGORY_LABEL, activeVendors, formatOverlap, hasText, migrationVendors, relatedOptions, withArticle } from './vendor.ts'
import { DISCLAIMER, compareRows, priceBlocks, raTierSummary, voiceCount } from './compare.ts'
import { alternativesBody, alternativesDescription, alternativesLede } from './alternatives.ts'
import { migrateBlocks, migrateDescription, migrateLede } from './migrate.ts'

// Everything a page says about ReadAloud comes from src/content/readaloudFacts.ts. Everything it says about a vendor comes from that
// vendor's JSON. No price, limit or format is typed in the templates; test/seoLibrary/templates.test.ts scans the template sources
// for digits and money amounts to keep it that way.

const HOME: Crumb = { name: 'Home', path: '/' }

function sourcesBlock(v: Vendor, only?: (s: Vendor['sources'][number]) => boolean): Block {
  return { kind: 'sources', items: v.sources.filter(only ?? (() => true)).map((s) => ({ title: s.title, url: s.url, retrievedAt: s.retrievedAt })) }
}

export type LinkItem = { label: string; href: string; external?: boolean }
function pubLink(lib: Library, type: PageType, slug: string, label: string): LinkItem | null {
  return isPublished(lib.publish, type, slug) ? { label, href: pathFor(type, slug) } : null
}
const present = <T,>(x: T | null): x is T => x !== null

// ---------------------------------------------------------------- compare

function differenceBullets(v: Vendor): { text: string; sourceUrl?: string }[] {
  const out: { text: string; sourceUrl?: string }[] = []
  if (hasText(v.voices.count)) out.push({ text: `Voices: ${v.name} lists ${voiceCount(v)}, a wider choice than ${RA_NAME} offers.`, sourceUrl: v.voices.sourceUrl })
  else out.push({ text: `Voices: we could not read a voice count on ${poss(v.name)} pages, so we make no comparison of choice.` })
  if (v.ssml === 'yes') out.push({ text: `SSML: ${v.name} lists SSML support; ${RA_NAME} does not accept it, so markup in your text would have to be removed or rewritten.` })
  if (hasText(v.voices.customVoiceOrCloning)) out.push({ text: `Custom voices: ${v.name} lists ${lowerFirst(sentence(v.voices.customVoiceOrCloning))}`, sourceUrl: v.voices.sourceUrl })
  const stated = (['hipaa', 'soc2', 'gdpr'] as const).filter((k) => v.compliance[k] === 'stated')
  if (stated.length) out.push({ text: `Compliance: ${poss(v.name)} pages mention ${joinList(stated.map((k) => (k === 'soc2' ? 'SOC 2' : k.toUpperCase())))}; ${RA_NAME} claims none.`, sourceUrl: v.compliance.sourceUrl })
  if (v.compatibility.openaiSpeechCompatible === 'yes') out.push({ text: `Switching: both list an OpenAI-compatible speech endpoint, so a base URL, a key and a voice name may be all that changes. The OpenAI stock voice names all map to ${RA_VOICES.defaultId}.` })
  return out
}

function fitBlocks(v: Vendor): Block[] {
  const theirs = hasText(v.bestFor) ? `${v.name} may suit you if this describes you: ${lowerFirst(sentence(v.bestFor))}` : `We did not find a statement on ${poss(v.name)} pages about who it is built for.`
  return [
    { kind: 'h2', text: 'Which one fits' },
    { kind: 'p', text: theirs },
    { kind: 'p', text: `${RA_NAME} may suit you for streaming English speech at a low price per character.` },
  ]
}

function licensingBlocks(v: Vendor): Block[] {
  const items: { text: string; sourceUrl?: string }[] = []
  if (hasText(v.licensing.commercialUse)) items.push({ text: `Commercial use: ${sentence(v.licensing.commercialUse)}`, sourceUrl: v.licensing.sourceUrl })
  if (hasText(v.licensing.attributionOrConditions)) items.push({ text: `Attribution or conditions: ${sentence(v.licensing.attributionOrConditions)}`, sourceUrl: v.licensing.sourceUrl })
  if (!items.length) return []
  return [{ kind: 'h2', text: `${v.name} usage terms` }, { kind: 'p', text: 'From the vendor pages we reviewed; not legal advice.' }, { kind: 'list', items }]
}

export function compareModel(lib: Library, v: Vendor): LibraryPageModel {
  const path = paths.compare(v.slug)
  const date = longDate(v.retrievedAt)
  const lede = `A sourced comparison of ${RA_NAME} and ${v.name} (${withArticle(CATEGORY_LABEL[v.category])}), built from ${poss(v.name)} public pages as of ${date}, with prices per one million characters.`
  const blocks: Block[] = [
    { kind: 'verified', text: `Last verified ${date}.` },
    { kind: 'p', tone: 'note', text: DISCLAIMER(v.name, v.retrievedAt) },
    { kind: 'h2', text: `About ${v.name}` },
    { kind: 'p', text: `How ${v.name} positions itself: ${sentence(v.positioning)}` },
    ...priceBlocks(v),
    { kind: 'h2', text: 'Side by side' },
    { kind: 'p', text: `"${NOT_STATED_CAP}" marks what ${poss(v.name)} pages did not say. We print no head-to-head latency number.` },
    { kind: 'table', caption: `${RA_NAME} and ${v.name} compared`, columns: ['', RA_NAME, v.name], rows: compareRows(v) },
  ]
  if (hasText(v.compliance.note)) blocks.push({ kind: 'p', text: `About ${poss(v.name)} compliance wording: ${sentence(v.compliance.note)}`, })
  if (v.strengths.length) blocks.push({ kind: 'h2', text: `What ${v.name} lists as strengths` }, { kind: 'list', items: v.strengths.map((s) => ({ text: s.claim, sourceUrl: s.sourceUrl })) })
  if (v.limitations.length) {
    blocks.push({ kind: 'h2', text: `Conditions to check with ${v.name}` })
    blocks.push({ kind: 'p', text: 'Limits or conditions from the pages we reviewed.' })
    blocks.push({ kind: 'list', items: v.limitations.map((s) => ({ text: s.claim, sourceUrl: s.sourceUrl })) })
  }
  blocks.push(...licensingBlocks(v))
  blocks.push({ kind: 'h2', text: `Where ${RA_NAME} is different` }, { kind: 'list', items: differenceBullets(v) })
  blocks.push(...fitBlocks(v))
  if (v.unknowns.length) blocks.push({ kind: 'h2', text: `What we could not confirm about ${v.name}` }, { kind: 'list', items: v.unknowns.map((text) => ({ text })) })
  const handWritten = HAND_WRITTEN_MIGRATIONS[v.slug]
  const related = [
    pubLink(lib, 'alternatives', v.slug, `${v.name} alternatives`),
    handWritten ? { label: handWritten.label, href: handWritten.href } : migrationVendors(lib).some((m) => m.slug === v.slug) ? pubLink(lib, 'migrate', v.slug, `Moving from ${v.name} to ${RA_NAME}`) : null,
    ...activeVendors(lib).filter((o) => o.slug !== v.slug).sort((a, b) => Number(b.category === v.category) - Number(a.category === v.category) || a.name.localeCompare(b.name)).slice(0, 3).map((o) => pubLink(lib, 'compare', o.slug, `${RA_NAME} vs ${o.name}`)),
  ].filter(present)
  if (related.length) blocks.push({ kind: 'links', title: 'Related pages', items: related })
  blocks.push({ kind: 'h2', text: 'Sources', id: 'sources' }, sourcesBlock(v))
  return {
    type: 'compare', slug: v.slug, key: publishKey('compare', v.slug), path,
    title: fitTitle(`${RA_NAME} vs ${v.name}: price per 1M characters and features`, `${RA_NAME} vs ${v.name}: price per 1M characters`, `${RA_NAME} vs ${v.name}`),
    description: fitDescription(`Compare ${RA_NAME} and ${v.name} on price per 1M characters, streaming, voices and limits, using ${poss(v.name)} public pages reviewed ${date}.`, `${RA_NAME} and ${v.name} compared on price per 1M characters, streaming and limits, from pages reviewed ${date}.`, `${RA_NAME} and ${v.name} compared on price and features, from pages reviewed ${date}.`),
    h1: `${RA_NAME} vs ${v.name}`, lede,
    breadcrumbs: [HOME, { name: 'Compare', path: '/compare' }, { name: `${RA_NAME} vs ${v.name}`, path }],
    blocks, vendorSlug: v.slug, vendorName: v.name, lastVerified: v.retrievedAt,
  }
}

// ---------------------------------------------------------------- alternatives

export function alternativesModel(lib: Library, v: Vendor): LibraryPageModel {
  const path = paths.alternatives(v.slug)
  const date = longDate(v.retrievedAt)
  const { blocks: body, relatedSlugs } = alternativesBody(lib, v)
  const blocks: Block[] = [
    { kind: 'verified', text: `Last verified ${date}.` },
    { kind: 'p', tone: 'note', text: `We make ${RA_NAME}, so it appears below as one of the options, and we say so. Options are listed alphabetically, not ranked.` },
    ...body,
  ]
  const handWritten = HAND_WRITTEN_MIGRATIONS[v.slug]
  const related = [
    pubLink(lib, 'compare', v.slug, `${RA_NAME} vs ${v.name}`),
    handWritten ? { label: handWritten.label, href: handWritten.href } : migrationVendors(lib).some((m) => m.slug === v.slug) ? pubLink(lib, 'migrate', v.slug, `Moving from ${v.name} to ${RA_NAME}`) : null,
    ...relatedSlugs.map((s) => pubLink(lib, 'compare', s, `${RA_NAME} vs ${lib.vendors.find((x) => x.slug === s)?.name ?? s}`)),
  ].filter(present)
  if (related.length) blocks.push({ kind: 'links', title: 'Related pages', items: related })
  blocks.push({ kind: 'p', tone: 'note', text: DISCLAIMER(v.name, v.retrievedAt) })
  blocks.push({ kind: 'h2', text: 'Sources', id: 'sources' }, sourcesBlock(v))
  return {
    type: 'alternatives', slug: v.slug, key: publishKey('alternatives', v.slug), path,
    title: fitTitle(`${v.name} alternatives: what to consider`, `${v.name} alternatives`),
    description: alternativesDescription(v, date, relatedSlugs.length),
    h1: `${v.name} alternatives`,
    lede: alternativesLede(v, date),
    breadcrumbs: [HOME, { name: 'Alternatives', path: '/alternatives' }, { name: `${v.name} alternatives`, path }],
    blocks, vendorSlug: v.slug, vendorName: v.name, lastVerified: v.retrievedAt,
  }
}

// ---------------------------------------------------------------- migrate

export function migrateModel(lib: Library, v: Vendor): LibraryPageModel {
  const path = paths.migrate(v.slug)
  const date = longDate(v.retrievedAt)
  const blocks = migrateBlocks(lib, v)
  const related = [pubLink(lib, 'compare', v.slug, `${RA_NAME} vs ${v.name}`), pubLink(lib, 'alternatives', v.slug, `${v.name} alternatives`)].filter(present)
  if (related.length) blocks.push({ kind: 'links', title: 'Related pages', items: related })
  blocks.push({ kind: 'h2', text: 'Sources', id: 'sources' }, sourcesBlock(v, (s) => v.migration.sourceUrls.includes(s.url) || v.pricing.sourceUrls.includes(s.url) || v.limits.sourceUrl === s.url || v.voices.sourceUrl === s.url || v.licensing.sourceUrl === s.url || v.streaming.sourceUrl === s.url))
  return {
    type: 'migrate', slug: v.slug, key: publishKey('migrate', v.slug), path,
    title: fitTitle(`Moving from ${v.name} to ${RA_NAME}: a checklist`, `Moving from ${v.name} to ${RA_NAME}`),
    description: migrateDescription(v, date),
    h1: `Moving from ${v.name} to ${RA_NAME}`,
    lede: migrateLede(v, date),
    breadcrumbs: [HOME, { name: 'Migrate', path: '/migrate' }, { name: `From ${v.name}`, path }],
    blocks, vendorSlug: v.slug, vendorName: v.name, lastVerified: v.retrievedAt,
  }
}

// ---------------------------------------------------------------- use cases and integrations

function relatedLinks(lib: Library, slugs: string[], selfType: 'use-case' | 'integration', selfSlug: string): LinkItem[] {
  const out: LinkItem[] = []
  for (const s of slugs) {
    const uc = lib.useCases.find((x) => x.slug === s)
    if (uc && !(selfType === 'use-case' && s === selfSlug) && isPublished(lib.publish, 'use-case', s)) out.push({ label: uc.name, href: paths.useCase(s) })
    const ig = lib.integrations.find((x) => x.slug === s)
    if (ig && !(selfType === 'integration' && s === selfSlug) && isPublished(lib.publish, 'integration', s)) out.push({ label: ig.name, href: paths.integration(s) })
  }
  return out
}

export function costBlocks(): Block[] {
  return [
    { kind: 'h2', text: `What ${RA_NAME} costs` },
    { kind: 'list', items: [
      { text: `${RA_LIVE.name}: ${usd(RA_LIVE.per1MUsd)} per 1M characters ($${RA_LIVE.per1kUsd} per 1,000), ${RA_LIVE.role}.` },
      { text: `${RA_STUDIO.name}: ${usd(RA_STUDIO.per1MUsd)} per 1M characters ($${RA_STUDIO.per1kUsd} per 1,000), ${RA_STUDIO.role}.` },
    ] },
    { kind: 'p', text: `Billing is per character of speech that finishes; cancelled requests are not billed, and there are no minimums. ${RA_FREE_CREDITS.wording} Current prices are on the Voice API page (${RA_PATHS.developers}).` },
  ]
}

function useCaseBlocks(lib: Library, d: UseCase): Block[] {
  const blocks: Block[] = []
  blocks.push({ kind: 'h2', text: 'How it works' }, { kind: 'list', ordered: true, items: d.steps.map((text) => ({ text })) })
  blocks.push({ kind: 'h2', text: 'A sample text' }, { kind: 'p', tone: 'note', text: 'An illustrative example written for this page. It is the text you would send to the API, not a recording, and it makes no claim about how the audio sounds.' })
  blocks.push({ kind: 'example', title: d.sampleExample.title, input: d.sampleExample.input, notes: d.sampleExample.notes || undefined })
  blocks.push({ kind: 'h2', text: `When ${RA_NAME} fits` }, { kind: 'list', items: d.whenToChooseReadAloud.map((text) => ({ text })) })
  blocks.push({ kind: 'h2', text: 'When another service may suit you' }, { kind: 'list', items: d.whenToChooseSomethingElse.map((text) => ({ text })) })
  blocks.push({ kind: 'h2', text: 'Features used' }, { kind: 'list', items: d.featuresUsed.map((f) => ({ text: `${f.feature}: ${f.howItHelps}` })) })
  blocks.push({ kind: 'h2', text: 'Things to consider' }, { kind: 'list', items: [...d.considerations.map((text) => ({ text })), { text: RA_LANGUAGES.statement }, { text: RA_COMPLIANCE_STATEMENT }] })
  blocks.push(...costBlocks())
  blocks.push({ kind: 'h2', text: 'Common questions' }, { kind: 'faq', items: d.faq })
  const rel = relatedLinks(lib, d.relatedSlugs, 'use-case', d.slug)
  if (rel.length) blocks.push({ kind: 'links', title: 'Related pages', items: rel })
  blocks.push({ kind: 'p', tone: 'note', text: `Something here does not match what you see? Tell us at ${RA_SUPPORT_EMAIL}.` })
  return blocks
}

function integrationBlocks(lib: Library, d: Integration): Block[] {
  const blocks: Block[] = []
  if (hasText(d.install)) blocks.push({ kind: 'h2', text: 'Install' }, { kind: 'code', language: 'bash', code: d.install })
  blocks.push({ kind: 'h2', text: 'Quickstart' }, { kind: 'code', language: d.quickstart.language, code: d.quickstart.code, caption: `Quickstart (${d.quickstart.language})` })
  blocks.push({ kind: 'h2', text: 'What was tested' })
  blocks.push({ kind: 'p', text: `Checked with ${d.verifiedWith.packageOrSdk}${hasText(d.verifiedWith.version) ? ` version ${d.verifiedWith.version}` : ''} on ${longDate(d.verifiedWith.date)}. This is one dated check against the live API. Other versions, and later releases, may behave differently.` })
  if (d.whatWorks.length) blocks.push({ kind: 'h3', text: 'What worked' }, { kind: 'list', items: d.whatWorks.map((text) => ({ text })) })
  if (d.limitations.length) blocks.push({ kind: 'h3', text: 'Limits and what is not supported' }, { kind: 'list', items: d.limitations.map((text) => ({ text })) })
  blocks.push({ kind: 'h2', text: 'Limits that apply to every integration' }, { kind: 'list', items: [
    { text: `${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters per request. Split longer text and send it in order.` },
    { text: `Output formats on the OpenAI-compatible route: ${RA_FORMATS.openaiRouteDetail}.` },
    { text: RA_VOICES.noSsml },
    { text: RA_LIMITS.atCapacity },
  ] })
  blocks.push(...costBlocks())
  if (d.links.length) blocks.push({ kind: 'links', title: 'Links', items: d.links.map((l) => ({ label: l.label, href: l.url, external: true })) })
  blocks.push({ kind: 'h2', text: 'Common questions' }, { kind: 'faq', items: d.faq })
  const rel = relatedLinks(lib, d.relatedSlugs, 'integration', d.slug)
  if (rel.length) blocks.push({ kind: 'links', title: 'Related pages', items: rel })
  blocks.push({ kind: 'p', tone: 'note', text: `Something here does not match what you see? Tell us at ${RA_SUPPORT_EMAIL}.` })
  return blocks
}

export function useCaseModel(lib: Library, d: UseCase): LibraryPageModel {
  const path = paths.useCase(d.slug)
  return {
    type: 'use-case', slug: d.slug, key: publishKey('use-case', d.slug), path,
    title: fitTitle(d.h1), description: d.metaDescription, h1: d.h1, lede: d.intro,
    breadcrumbs: [HOME, { name: 'Use cases', path: '/use-cases' }, { name: d.name, path }],
    blocks: useCaseBlocks(lib, d), faqJsonLd: d.faq,
  }
}

export function integrationModel(lib: Library, d: Integration): LibraryPageModel {
  const path = paths.integration(d.slug)
  return {
    type: 'integration', slug: d.slug, key: publishKey('integration', d.slug), path,
    title: fitTitle(d.h1), description: d.metaDescription, h1: d.h1, lede: d.intro,
    breadcrumbs: [HOME, { name: 'Integrations', path: '/integrations' }, { name: d.name, path }],
    blocks: integrationBlocks(lib, d), faqJsonLd: d.faq,
  }
}

// ---------------------------------------------------------------- entry points

export function buildPages(lib: Library): LibraryPageModel[] {
  const active = activeVendors(lib)
  return [
    ...active.map((v) => compareModel(lib, v)),
    ...active.map((v) => alternativesModel(lib, v)),
    ...migrationVendors(lib, Object.keys(HAND_WRITTEN_MIGRATIONS)).map((v) => migrateModel(lib, v)),
    ...lib.integrations.map((d) => integrationModel(lib, d)),
    ...lib.useCases.map((d) => useCaseModel(lib, d)),
  ]
}

export type HubKey = 'compare' | 'alternatives' | 'migrate' | 'integrations' | 'use-cases'

export function hubModels(): Record<HubKey, HubModel> {
  const mk = (type: HubModel['type'], p: string, name: string, title: string, description: string, h1: string, lede: string): HubModel => ({ type, path: p, title, description, h1, lede, breadcrumbs: [HOME, { name, path: p }] })
  return {
    compare: mk('compare', '/compare', 'Compare', 'ReadAloud compared with other text-to-speech services | ReadAloud AI', 'Sourced comparisons of ReadAloud with text-to-speech APIs and tools: price per 1M characters, streaming, voices and limits, each with sources and a review date.', 'ReadAloud compared with other text-to-speech services', 'One page per vendor, built from the vendor\'s public pages with sources and a review date. Prices are shown per one million characters, with the tier each price covers. We make ReadAloud, and we say where a vendor is lower on price or wider on voices.'),
    alternatives: mk('alternatives', '/alternatives', 'Alternatives', 'Text-to-speech alternatives, compared from public pages | ReadAloud AI', 'Neutral guides to choosing an alternative to a text-to-speech service, each built from the vendor\'s public pages with sources and a review date.', 'Text-to-speech alternatives', 'What to consider when choosing an alternative to a text-to-speech service. Each guide names what the service lists as strengths, gives questions to ask, and shows the options, including ReadAloud, which we make.'),
    migrate: mk('migrate', '/migrate', 'Migrate', 'Moving to ReadAloud from another text-to-speech service | ReadAloud AI', 'Checklists for moving from another text-to-speech API to ReadAloud: what changes, what does not carry over and how to test, from each vendor\'s public pages.', 'Moving to ReadAloud', 'Checklists for moving text-to-speech calls from another vendor to ReadAloud, one guide per vendor, each with sources and a review date.'),
    integrations: mk('integrations', '/integrations', 'Integrations', 'ReadAloud integrations for voice agents and apps | ReadAloud AI', 'How to use ReadAloud text to speech from voice-agent frameworks, SDKs and tools, with the version each setup was checked with and what is not supported.', 'ReadAloud integrations', 'How to use ReadAloud text to speech from the frameworks and tools you already use, with a quickstart, the version each setup was checked with, and what is not supported.'),
    'use-cases': mk('use-cases', '/use-cases', 'Use cases', 'Text-to-speech use cases | ReadAloud AI', 'Common jobs for text to speech, such as voice agents, audio versions of articles and notifications: how each works, a sample text and what to consider.', 'Text-to-speech use cases', 'The jobs people give a text-to-speech API, from voice agents to audio versions of articles: how each works with ReadAloud, a sample text, and when another service may suit you better.'),
  }
}

