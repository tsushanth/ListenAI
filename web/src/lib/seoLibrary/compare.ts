import {
  RA_API_BASE, RA_CLONING, RA_COMPLIANCE_STATEMENT, RA_CERTIFICATION_ALLOW_LIST, RA_FORMATS, RA_FREE_CREDITS, RA_LANGUAGES, RA_LATENCY, RA_LIMITS, RA_LIVE, RA_NAME, RA_OPENAI_ROUTE, RA_PATHS,
  RA_STREAMING, RA_STUDIO, RA_SUPPORT_EMAIL, RA_VOICES,
} from '../../content/readaloudFacts.ts'
import type { Vendor } from './schema.ts'
import type { Block, Cell } from './model.ts'
import { NOT_STATED_CAP, joinList, longDate, lowerFirst, poss, sentence, usd } from './helpers.ts'
import { difference, hasText, numericRows, priceRows, priceStatements, priceText, relation } from './vendor.ts'

// Building blocks shared by the compare, alternatives and migrate pages. Every ReadAloud statement is read from readaloudFacts.ts,
// every vendor statement from the vendor's JSON; no price, limit or format is typed in this file.

export const DISCLAIMER = (name: string, date: string) =>
  `Details about ${name} come from its public pages as they were on ${longDate(date)}. ${name} may have changed them since, and a page that was unclear to us may be clear to you. Corrections: ${RA_SUPPORT_EMAIL}. We make ${RA_NAME}, so read this page with that in mind and check anything important with ${name} directly.`

/**
 * The prominent notice on every page about a vendor with an announced end date. It quotes the vendor's own pages (short quotations
 * kept in the vendor JSON, with the pages they come from) and says when we read them. Nothing here is our own claim about the vendor.
 */
export function sunsetBlocks(v: Vendor): Block[] {
  const s = v.sunset
  if (v.status !== 'sunsetting' || !s) return []
  const when = longDate(s.date)
  const src = s.noticeSourceUrls
  const read = v.sources.find((x) => x.url === src[0])?.retrievedAt ?? v.retrievedAt
  const items: { text: string; sourceUrl?: string }[] = [{ text: `${poss(v.name)} own documentation says: "${s.notice}"`, sourceUrl: src[0] }]
  if (hasText(s.dataDeletion)) items.push({ text: `It also says: "${s.dataDeletion}"`, sourceUrl: src[1] ?? src[0] })
  items.push({ text: `We read ${src.length > 1 ? 'these statements on its documentation pages' : 'this statement on its documentation page'} on ${longDate(read)}. If you use ${v.name} today, plan your move before ${when} and export anything you need first. Check ${poss(v.name)} documentation in case the date has changed.` })
  return [{ kind: 'alert', title: `${v.name} is scheduled to end on ${when}`, items }]
}

export const certCell = (key: string) => (RA_CERTIFICATION_ALLOW_LIST.includes(key) ? 'Stated by ReadAloud' : 'Not claimed')
export const statedCell = (v: 'stated' | 'not-stated', hasNote = false): string => (v === 'stated' ? (hasNote ? 'Mentioned on their pages; see the note below the table for what it covers' : 'Stated on their pages') : NOT_STATED_CAP)

export const ynuCell = (v: 'yes' | 'no' | 'unknown', note = ''): string => {
  const base = v === 'yes' ? 'Yes' : v === 'no' ? 'No' : NOT_STATED_CAP
  return note && v !== 'unknown' ? `${base}. ${sentence(note)}` : base
}

export const raTierSummary = `${RA_LIVE.name} is ${RA_LIVE.role}; ${RA_STUDIO.name} is ${RA_STUDIO.role}.`

export const raPriceCell = `${RA_LIVE.name} ${usd(RA_LIVE.per1MUsd)} and ${RA_STUDIO.name} ${usd(RA_STUDIO.per1MUsd)} per 1M characters ($${RA_LIVE.per1kUsd} and $${RA_STUDIO.per1kUsd} per 1,000), billed per character of speech that finishes`

/** The vendor's own latency statement, quoted and attributed, or null. ReadAloud never restates a vendor's figure as its own finding. */
export function vendorLatencyCell(v: Vendor): Cell {
  if (hasText(v.streaming.vendorStatedLatency)) return { text: `Vendor-stated: ${v.streaming.vendorStatedLatency.replace(/^\s*vendor[- ]stated:?\s*/i, '')}`, sourceUrl: v.streaming.sourceUrl }
  return { text: NOT_STATED_CAP }
}

export const raLatencyCell = `${RA_LIVE.name}: ${RA_LATENCY.liveWarmLabel} (${RA_LATENCY.methodShort}; ${longDate(RA_LATENCY.measuredOn)}; ${RA_LATENCY.methodPath})`

export function streamingText(v: Vendor): string {
  const ws = v.streaming.websocket
  const http = v.streaming.http
  const note = hasText(v.streaming.note) ? sentence(v.streaming.note) : ''
  if (ws === 'unknown' && http === 'unknown') return note || NOT_STATED_CAP
  const bit = (label: string, x: 'yes' | 'no' | 'unknown') => `${label}: ${x === 'yes' ? 'yes' : x === 'no' ? 'no' : 'not stated'}`
  return `${bit('WebSocket', ws)}; ${bit('HTTP streaming', http)}${note ? `. ${note}` : ''}`
}

/** "thousands of library voices" stays as written; "120" becomes "120 voices". */
export const voiceCount = (v: Vendor): string => (/voice/i.test(v.voices.count) ? v.voices.count : `${v.voices.count} voices`)

function voiceText(v: Vendor): string {
  return hasText(v.voices.count) ? voiceCount(v) : NOT_STATED_CAP
}

/** Rows shown in the side-by-side table. A row appears when ReadAloud has a statement for it; vendor gaps read "Not stated". */
export function compareRows(v: Vendor): Cell[][] {
  const rows: Cell[][] = []
  const vs = v.voices.sourceUrl
  const c = v.compliance.sourceUrl

  rows.push([{ text: 'Voices' }, { text: RA_VOICES.short }, { text: voiceText(v), sourceUrl: vs }])
  rows.push([{ text: 'Languages' }, { text: RA_LANGUAGES.short }, hasText(v.voices.languages) ? { text: v.voices.languages, sourceUrl: vs } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'Custom voices or cloning' }, { text: RA_CLONING.short }, hasText(v.voices.customVoiceOrCloning) ? { text: v.voices.customVoiceOrCloning, sourceUrl: vs } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'Streaming' }, { text: RA_STREAMING.short }, { text: streamingText(v), sourceUrl: v.streaming.sourceUrl }])
  rows.push([{ text: 'Time to first audio' }, { text: raLatencyCell }, vendorLatencyCell(v)])
  rows.push([{ text: 'Output formats' }, { text: RA_FORMATS.short }, v.formats.length ? { text: v.formats.join(', ') } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'SSML' }, { text: RA_VOICES.noSsml }, { text: ynuCell(v.ssml) }])
  rows.push([{ text: 'OpenAI-compatible speech endpoint' }, { text: `Yes, ${RA_OPENAI_ROUTE.path}` }, { text: ynuCell(v.compatibility.openaiSpeechCompatible, v.compatibility.note) }])
  rows.push([{ text: 'Limit per request' }, { text: `${RA_LIMITS.perRequestCharacters.toLocaleString('en-US')} characters` }, hasText(v.limits.perRequestCharacters) ? { text: v.limits.perRequestCharacters, sourceUrl: v.limits.sourceUrl } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'Concurrency' }, { text: RA_LIMITS.short }, hasText(v.limits.concurrency) ? { text: v.limits.concurrency, sourceUrl: v.limits.sourceUrl } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'SDKs and plugins' }, { text: 'Python and JavaScript libraries (readaloud), Pipecat and LiveKit plugins, any OpenAI SDK' }, v.sdks.length ? { text: joinList(v.sdks) } : { text: NOT_STATED_CAP }])
  rows.push([{ text: 'HIPAA' }, { text: certCell('hipaa') }, { text: statedCell(v.compliance.hipaa, hasText(v.compliance.note)), sourceUrl: c }])
  rows.push([{ text: 'SOC 2' }, { text: certCell('soc2') }, { text: statedCell(v.compliance.soc2, hasText(v.compliance.note)), sourceUrl: c }])
  rows.push([{ text: 'GDPR' }, { text: certCell('gdpr') }, { text: statedCell(v.compliance.gdpr, hasText(v.compliance.note)), sourceUrl: c }])
  return rows
}

// ---------------------------------------------------------------- price section

export function priceBlocks(v: Vendor, opts: { heading?: string } = {}): Block[] {
  const src = v.pricing.sourceUrls[0]
  const out: Block[] = [{ kind: 'h2', text: opts.heading ?? 'Price per 1 million characters' }]
  out.push({
    kind: 'p',
    text: `USD per one million characters, by tier. Other units are shown as the vendor writes them, not converted.`,
  })
  const rows: Cell[][] = []
  rows.push([{ text: RA_LIVE.name }, { text: `${usd(RA_LIVE.per1MUsd)} per 1M characters` }, { text: RA_LIVE.role }, { text: 'Reference point' }])
  rows.push([{ text: RA_STUDIO.name }, { text: `${usd(RA_STUDIO.per1MUsd)} per 1M characters` }, { text: RA_STUDIO.role }, { text: `${usd(difference(RA_STUDIO.per1MUsd, RA_LIVE.per1MUsd))} above ${RA_LIVE.name}` }])
  const vendorRows = priceRows(v)
  for (const r of vendorRows) {
    const cmp = r.per1M === null ? `Not comparable: ${v.name} lists a different unit` : relationText(r.per1M)
    rows.push([{ text: `${v.name}: ${r.name}` }, { text: priceText(r), sourceUrl: src }, { text: r.notes || `Tier as named by ${v.name}` }, { text: cmp }])
  }
  out.push({ kind: 'table', caption: `List prices: ${RA_NAME} and ${v.name}`, columns: ['Option', 'Listed price', 'What it covers', `Against ${RA_LIVE.name}`], rows })
  for (const s of priceStatements(v)) out.push({ kind: 'p', text: s })
  if (hasText(v.pricing.headline)) out.push({ kind: 'p', text: `${poss(v.name)} own headline, as of ${longDate(v.retrievedAt)}: ${sentence(v.pricing.headline)}` })
  if (hasText(v.pricing.freeTier)) out.push({ kind: 'p', text: `Free tier at ${v.name}: ${sentence(v.pricing.freeTier)} ${RA_NAME}: ${RA_FREE_CREDITS.short}` })
  else out.push({ kind: 'p', text: `We did not find a free tier on ${poss(v.name)} pricing pages. ${RA_NAME}: ${RA_FREE_CREDITS.short}` })
  if (v.pricing.promotions.length) out.push({ kind: 'list', items: v.pricing.promotions.map((t) => ({ text: `Time-limited or scheduled pricing listed when we reviewed: ${sentence(t)}`, sourceUrl: src })) })
  out.push({ kind: 'p', text: `Tiers cover different things, so compare on your own monthly volume, and check ${poss(v.name)} pricing page before you decide. Current ${RA_NAME} prices: ${RA_PATHS.developers}.` })
  return out
}

function relationText(price: number): string {
  const rel = relation(price, RA_LIVE.per1MUsd)
  if (rel === 'same') return `Same as ${RA_LIVE.name}`
  const d = usd(difference(price, RA_LIVE.per1MUsd))
  return rel === 'lower' ? `${d} lower than ${RA_LIVE.name}` : `${d} higher than ${RA_LIVE.name}`
}

/** True when any listed per-character price of the vendor is below a ReadAloud tier. */
export function vendorIsLowerSomewhere(v: Vendor): boolean {
  return numericRows(v).some((r) => relation(r.per1M, RA_STUDIO.per1MUsd) === 'lower' || relation(r.per1M, RA_LIVE.per1MUsd) === 'lower')
}

export { RA_API_BASE, lowerFirst }
