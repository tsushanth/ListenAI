import {
  RA_COMPLIANCE_STATEMENT, RA_FORMATS, RA_FREE_CREDITS, RA_LANGUAGES, RA_LIMITS, RA_LIVE, RA_NAME, RA_OPENAI_ROUTE, RA_PATHS, RA_STREAMING, RA_STUDIO, RA_VOICES,
} from '../../content/readaloudFacts.ts'
import type { Vendor, VendorCategory } from './schema.ts'
import type { Library } from './load.ts'
import type { Block } from './model.ts'
import { NOT_STATED, hash, joinList, lowerFirst, poss, sentence, usd } from './helpers.ts'
import { CATEGORY_LABEL, FAMILY_PHRASE, hasText, numericRows, priceFamily, priceRows, priceStatements, priceText, relatedOptions, withArticle } from './vendor.ts'
import { vendorLatencyCell, voiceCount } from './compare.ts'

// The body of every /alternatives/<slug>-alternatives page. Three rules keep these pages from becoming thin, near-duplicate
// programmatic pages:
//   1. Every vendor statement is read from that vendor's JSON and carries its sourceUrl where the data has one.
//   2. Every ReadAloud statement is read from src/content/readaloudFacts.ts. No number, price or tier name is typed in this file
//      (test/seoLibrary/templates.test.ts scans it).
//   3. The sections, their order and their explanatory text depend on the vendor's category (api-platform, cloud-provider, studio-tool,
//      model-vendor, open-source-host) and on which data points exist, and the checklist is drawn from a larger pool by that vendor's own
//      data, so two pages share facts only when the data does.

const LANG_CLIP = 90

type Item = { text: string; sourceUrl?: string }
type Section = (v: Vendor, lib: Library) => Block[]

const priceSrc = (v: Vendor) => v.pricing.sourceUrls[0]
const catLabel = (v: Vendor) => CATEGORY_LABEL[v.category]

const pick = <T,>(items: T[], key: string, n: number): T[] => {
  const scored = items.map((it, i) => ({ it, k: hash(`${key}:${i}`) })).sort((a, b) => a.k - b.k).slice(0, n).map((x) => x.it)
  return items.filter((it) => scored.includes(it))
}

// ---------------------------------------------------------------- sections

const who: Section = (v) => {
  const audience = hasText(v.bestFor) ? `The audience its pages name: ${lowerFirst(sentence(v.bestFor))}` : `${poss(v.name)} pages do not say who it is built for, so judge the fit from the sections below.`
  const family = FAMILY_PHRASE[priceFamily(v)]
  const intro: Record<VendorCategory, string> = {
    'api-platform': `We file ${v.name} under text-to-speech API platforms: companies whose main product is a speech API that developers call from their own code. It ${family}.`,
    'cloud-provider': `We file ${v.name} under cloud provider speech services: speech is one product among many in a larger cloud account, with its own console, billing and permissions. It ${family}.`,
    'studio-tool': `We file ${v.name} under studio and app-based voice tools: products built around an editor or app where you paste a script and export audio, sometimes with an API on the side. It ${family}.`,
    'model-vendor': `We file ${v.name} under model vendors: companies known mainly for language or multimodal models that also offer a speech endpoint. It ${family}.`,
    'open-source-host': `We file ${v.name} under hosts for open-source voice models: you run community or vendor models on rented infrastructure instead of calling one fixed product. It ${family}.`,
  }
  return [{ kind: 'h2', text: v.category === 'studio-tool' ? `What kind of product ${v.name} is` : `Who ${v.name} suits` }, { kind: 'p', text: `${intro[v.category]} ${audience}` }]
}

const pricing: Section = (v) => {
  const out: Block[] = [{ kind: 'h2', text: `How ${v.name} prices` }]
  out.push({ kind: 'p', text: `In ${poss(v.name)} words: ${sentence(v.pricing.model)}` })
  const rows = priceRows(v)
  if (rows.length) {
    out.push({ kind: 'list', items: rows.map((r): Item => ({ text: `${r.name}: ${priceText(r)}${r.notes ? `. ${sentence(r.notes)}` : ''}`, sourceUrl: priceSrc(v) })) })
  }
  const note: Record<VendorCategory, string> = {
    'api-platform': 'Check whether the listed rate is for the model and latency class you would actually call, and whether concurrency or support tiers cost extra.',
    'cloud-provider': 'Check the difference between voice classes, whether the free allowance renews monthly or runs out once, and what the account minimums and regional prices are.',
    'studio-tool': 'Check whether plans count characters, minutes of finished audio or seats, and whether API calls draw from the same allowance as the app.',
    'model-vendor': 'Check which unit the speech endpoint is billed in, since model vendors often price speech differently from text, and compare in that unit before converting anything.',
    'open-source-host': 'Check whether you pay per second of compute or per request, what a cold start costs, and who owns the model license.',
  }
  out.push({ kind: 'p', text: note[v.category] })
  for (const s of priceStatements(v)) out.push({ kind: 'p', text: s })
  if (hasText(v.pricing.freeTier)) out.push({ kind: 'p', text: `Free tier at ${v.name}: ${sentence(v.pricing.freeTier)}` })
  return out
}

const latency: Section = (v) => {
  const lat = vendorLatencyCell(v)
  const out: Block[] = [{ kind: 'h2', text: 'Streaming and time to first audio' }]
  const ws = v.streaming.websocket
  const http = v.streaming.http
  const bits = [ws !== 'unknown' ? `WebSocket streaming ${ws === 'yes' ? 'is listed' : 'is not listed'}` : '', http !== 'unknown' ? `HTTP streaming ${http === 'yes' ? 'is listed' : 'is not listed'}` : ''].filter(Boolean)
  out.push({ kind: 'p', text: `${bits.length ? `${v.name}: ${joinList(bits)}.` : `We could not read a streaming statement on ${poss(v.name)} pages.`} ${hasText(v.streaming.vendorStatedLatency) ? `${lat.text}.` : 'No latency figure is stated on the pages we reviewed.'} Test from your own servers with your own text.` })
  return out
}

const voices: Section = (v) => {
  const bits: string[] = []
  if (hasText(v.voices.count)) bits.push(voiceCount(v))
  if (hasText(v.voices.languages)) bits.push(`languages listed: ${v.voices.languages}`)
  if (hasText(v.voices.customVoiceOrCloning)) bits.push(`custom voices: ${v.voices.customVoiceOrCloning}`)
  if (!bits.length) return []
  return [{ kind: 'h2', text: 'Voices and languages' }, { kind: 'p', text: `${v.name}: ${bits.join('; ')}.` }]
}

const limits: Section = (v) => {
  const items: Item[] = []
  if (hasText(v.limits.perRequestCharacters)) items.push({ text: `Per request: ${sentence(v.limits.perRequestCharacters)}`, sourceUrl: v.limits.sourceUrl })
  if (hasText(v.limits.concurrency)) items.push({ text: `Concurrency: ${sentence(v.limits.concurrency)}`, sourceUrl: v.limits.sourceUrl })
  if (v.formats.length) items.push({ text: `Output formats listed: ${joinList(v.formats)}.` })
  if (v.ssml !== 'unknown') items.push({ text: `SSML ${v.ssml === 'yes' ? 'is listed as supported' : 'is not listed as supported'}.` })
  if (!items.length) return []
  return [{ kind: 'h2', text: 'Limits and formats' }, { kind: 'list', items }]
}

const compat: Section = (v) => {
  const yn = v.compatibility.openaiSpeechCompatible
  if (yn === 'unknown' && !hasText(v.compatibility.note)) return []
  return [
    { kind: 'h2', text: 'API shape and switching cost' },
    { kind: 'p', text: `${yn === 'yes' ? `${v.name} lists an OpenAI-compatible speech endpoint.` : yn === 'no' ? `${v.name} does not list an OpenAI-compatible speech endpoint.` : `We could not tell whether ${v.name} offers an OpenAI-compatible speech endpoint.`}${hasText(v.compatibility.note) ? ` ${sentence(v.compatibility.note)}` : ''}` },
  ]
}

const licensing: Section = (v) => {
  const items: Item[] = []
  if (hasText(v.licensing.commercialUse)) items.push({ text: `Commercial use: ${sentence(v.licensing.commercialUse)}`, sourceUrl: v.licensing.sourceUrl })
  if (hasText(v.licensing.attributionOrConditions)) items.push({ text: `Conditions: ${sentence(v.licensing.attributionOrConditions)}`, sourceUrl: v.licensing.sourceUrl })
  if (!items.length) return []
  return [{ kind: 'h2', text: 'Licensing and usage terms' }, { kind: 'p', text: `From ${poss(v.name)} pages; not legal advice.` }, { kind: 'list', items }]
}

const compliance: Section = (v) => {
  const stated = (['hipaa', 'soc2', 'gdpr'] as const).filter((k) => v.compliance[k] === 'stated')
  if (!stated.length && !hasText(v.compliance.note)) return []
  const label = (k: string) => (k === 'soc2' ? 'SOC 2' : k.toUpperCase())
  return [
    { kind: 'h2', text: 'Account, compliance and data handling' },
    { kind: 'p', text: `${stated.length ? `${poss(v.name)} pages mention ${joinList(stated.map(label))}.` : `We did not find HIPAA, SOC 2 or GDPR wording on ${poss(v.name)} pages.`}${hasText(v.compliance.note) ? ` ${sentence(v.compliance.note)}` : ''} ${RA_COMPLIANCE_STATEMENT}` },
  ]
}

const listed: Section = (v) => {
  const out: Block[] = []
  if (v.strengths.length) out.push({ kind: 'h2', text: `What ${v.name} lists as strengths` }, { kind: 'list', items: v.strengths.map((x): Item => ({ text: x.claim, sourceUrl: x.sourceUrl })) })
  if (v.limitations.length) out.push({ kind: 'h2', text: `Conditions to check with ${v.name}` }, { kind: 'list', items: v.limitations.map((x): Item => ({ text: x.claim, sourceUrl: x.sourceUrl })) })
  return out
}

const unconfirmed: Section = (v) => (v.unknowns.length ? [{ kind: 'h2', text: `What we could not confirm about ${v.name}` }, { kind: 'list', items: v.unknowns.map((text): Item => ({ text })) }] : [])

const SECTIONS: Record<VendorCategory, Section[]> = {
  'api-platform': [who, pricing, listed, latency, voices, limits, compat, unconfirmed],
  'cloud-provider': [who, listed, pricing, voices, compliance, limits, unconfirmed],
  'studio-tool': [who, pricing, voices, listed, licensing, limits, unconfirmed],
  'model-vendor': [who, pricing, compat, listed, voices, limits, compliance, unconfirmed],
  'open-source-host': [who, licensing, pricing, listed, latency, voices, limits, unconfirmed],
}

// ---------------------------------------------------------------- checklist

function checklist(v: Vendor): Item[] {
  const pool: (Item | null)[] = []
  const fam = priceFamily(v)
  pool.push(fam === 'per-character'
    ? { text: `Price your monthly characters on each ${v.name} tier you would use.` }
    : { text: `Convert your monthly volume into ${poss(v.name)} own unit before comparing, because ${v.name} ${FAMILY_PHRASE[fam]} and a per-character figure would need assumptions it does not state.` })
  pool.push(v.streaming.websocket === 'yes' ? { text: `If you stream text in as a language model produces it, confirm that ${poss(v.name)} WebSocket input handles partial sentences the way your code expects.` } : { text: 'Decide whether you need audio to start before the whole text is sent. If you do, check that the service you pick streams input as well as output.' })
  pool.push(hasText(v.limits.perRequestCharacters) ? { text: `${poss(v.name)} per-request limit is stated as: ${lowerFirst(v.limits.perRequestCharacters)}. Compare it with the length of your longest text and plan how you will split it.`, sourceUrl: v.limits.sourceUrl } : { text: `${poss(v.name)} per-request limit is not stated on the pages we reviewed, so test your longest text before you commit.` })
  pool.push(v.ssml === 'yes' ? { text: `If you rely on SSML for pauses or pronunciation, note that ${v.name} lists support for it and that ${RA_NAME} does not accept SSML.` } : { text: 'List the pronunciation problems you have today (names, acronyms, numbers) and test them, since not every service lets you correct them with markup.' })
  pool.push(hasText(v.voices.customVoiceOrCloning) ? { text: `If you need a custom voice, read ${poss(v.name)} consent and license terms before you record anyone.`, sourceUrl: v.voices.sourceUrl } : null)
  pool.push(v.compatibility.openaiSpeechCompatible === 'yes' ? { text: `${v.name} lists an OpenAI-compatible endpoint, so you can keep a thin adapter in your code and swap providers by changing a base URL.` } : null)
  pool.push(v.formats.length ? { text: `Check that your playback path accepts ${joinList(v.formats.slice(0, 4))} or the format you need; telephony usually needs 8 kHz audio.` } : null)
  pool.push((['hipaa', 'soc2', 'gdpr'] as const).some((k) => v.compliance[k] === 'stated') ? { text: `If a certification matters to you, ask ${v.name} for the report or agreement instead of relying on a web page.` } : { text: `If you need HIPAA, SOC 2 or GDPR assurances, ask each vendor what it can provide; we found no such wording on ${poss(v.name)} pages.` })
  pool.push(hasText(v.pricing.freeTier) ? { text: `Use ${poss(v.name)} free tier to run the same ten sentences you use in production, then do the same with each alternative.` } : { text: 'Run the same ten sentences from your real traffic through each option, and listen with the people who will hear it.' })
  pool.push(v.limitations.length ? { text: `Read the conditions ${v.name} lists (${v.limitations.length} in our notes) and see whether any of them applies to your volume or region.`, sourceUrl: v.limitations[0].sourceUrl } : null)
  const real = pool.filter((x): x is Item => x !== null)
  return [real[0], ...pick(real.slice(1), v.slug, 3)]
}

// ---------------------------------------------------------------- options

function optionsBlocks(lib: Library, v: Vendor): { blocks: Block[]; relatedSlugs: string[] } {
  const rel = relatedOptions(lib, v)
  const cards = [
    { title: RA_NAME, text: `A streaming text-to-speech API: ${RA_LIVE.name} at ${usd(RA_LIVE.per1MUsd)} and ${RA_STUDIO.name} at ${usd(RA_STUDIO.per1MUsd)} per 1M characters. ${RA_LANGUAGES.short}.`, href: RA_PATHS.developers, meta: 'Disclosure: this is our product' },
    ...rel.map((r) => ({ title: r.vendor.name, text: r.why, href: r.vendor.url, external: true, meta: `Reviewed ${r.vendor.retrievedAt}`, sourceUrl: r.vendor.pricing.sourceUrls[0] })),
  ].sort((a, b) => a.title.localeCompare(b.title))
  return {
    blocks: [
      { kind: 'h2', text: `Options besides ${v.name}` },
      { kind: 'p', text: `Three other vendors from our dataset, chosen because they share ${poss(v.name)} category or pricing model, and ${RA_NAME}, which we make. They are listed alphabetically, not ranked, and each summary comes from that vendor's own pages.` },
      { kind: 'cards', items: cards },
    ],
    relatedSlugs: rel.map((r) => r.vendor.slug),
  }
}

function raDifference(v: Vendor): Block[] {
  const rows = numericRows(v)
  const price = rows.length
    ? `${poss(v.name)} per-character figures are in the pricing list above, next to ${RA_LIVE.name} at ${usd(RA_LIVE.per1MUsd)} and ${RA_STUDIO.name} at ${usd(RA_STUDIO.per1MUsd)}.`
    : `${RA_NAME} bills per character (${usd(RA_LIVE.per1MUsd)} and ${usd(RA_STUDIO.per1MUsd)} per 1M characters), while ${v.name} uses a different unit.`
  return [
    { kind: 'h2', text: `How ${RA_NAME} differs from ${v.name}` },
    { kind: 'p', text: `${price} ${RA_VOICES.short} Requests are limited to ${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters.` },
  ]
}

// ---------------------------------------------------------------- entry points

export function alternativesBody(lib: Library, v: Vendor): { blocks: Block[]; relatedSlugs: string[] } {
  const blocks: Block[] = []
  for (const s of SECTIONS[v.category]) blocks.push(...s(v, lib))
  blocks.push({ kind: 'h2', text: `What to consider when choosing ${/^[aeiou]/i.test(v.name) ? 'an' : 'a'} ${v.name} alternative` }, { kind: 'list', items: checklist(v) })
  const opts = optionsBlocks(lib, v)
  blocks.push(...opts.blocks)
  blocks.push(...raDifference(v))
  return { blocks, relatedSlugs: opts.relatedSlugs }
}

export function alternativesLede(v: Vendor, date: string): string {
  return `What to consider when choosing a ${v.name} alternative (${withArticle(catLabel(v))}), built from ${poss(v.name)} public pages as of ${date}. ${RA_NAME}, which we make, is one disclosed option among several.`
}

export function alternativesDescription(v: Vendor, date: string, n: number): string {
  const c = [
    `What to consider when choosing a ${v.name} alternative: questions to ask, ${n} related vendors and ${RA_NAME}, from pages reviewed ${date}.`,
    `Choosing a ${v.name} alternative: what to check, ${n} related vendors and ${RA_NAME}, from pages reviewed ${date}.`,
    `A ${v.name} alternative guide: what to check and ${n} options, from pages reviewed ${date}.`,
  ]
  return c.find((x) => x.length <= 165) ?? c[c.length - 1]
}

export { NOT_STATED, RA_FORMATS, RA_STREAMING, RA_VOICES }
