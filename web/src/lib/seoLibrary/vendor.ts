import { RA_FORMATS, RA_LIVE, RA_STUDIO } from '../../content/readaloudFacts.ts'
import type { Library } from './load.ts'
import type { Vendor, VendorCategory } from './schema.ts'
import { MIGRATE_CAP, MIGRATE_PRIORITY } from './routes.ts'
import { hash, joinList, poss, usd } from './helpers.ts'

// Data helpers for vendor pages: price rows, price families, format overlap, related vendors. Nothing here types a ReadAloud number.

export const activeVendors = (lib: Library): Vendor[] => lib.vendors.filter((v) => v.status === 'active')

export const CATEGORY_LABEL: Record<VendorCategory, string> = {
  'api-platform': 'text-to-speech API platform',
  'cloud-provider': 'cloud provider speech service',
  'studio-tool': 'studio and app-based voice tool',
  'model-vendor': 'model vendor',
  'open-source-host': 'host for open-source voice models',
}

export const withArticle = (label: string): string => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

export const hasText = (s: string | undefined | null): s is string => !!s && !/^(not stated|unknown|n\/a|none)\b/i.test(s.trim())

// ---------------------------------------------------------------- prices

export type PriceRow = { name: string; per1M: number | null; unit: string; notes: string }

/** Every listed tier. When the researcher gave only a headline number, it becomes one row named after headlineTier. */
export function priceRows(v: Vendor): PriceRow[] {
  const rows: PriceRow[] = v.pricing.tiers.map((t) => ({ name: t.name, per1M: t.pricePer1MCharsUsd, unit: t.unit, notes: t.notes }))
  if (rows.length === 0 && v.pricing.pricePer1MCharsUsd !== null) {
    rows.push({ name: v.pricing.headlineTier || 'Headline tier', per1M: v.pricing.pricePer1MCharsUsd, unit: '1M characters', notes: '' })
  }
  return rows
}

/** The headline per-1M-characters price, when the data states one. */
export function headlinePer1M(v: Vendor): number | null {
  if (v.pricing.pricePer1MCharsUsd !== null) return v.pricing.pricePer1MCharsUsd
  const named = v.pricing.headlineTier ? v.pricing.tiers.find((t) => t.name.toLowerCase() === v.pricing.headlineTier.toLowerCase()) : undefined
  return named?.pricePer1MCharsUsd ?? null
}

export const numericRows = (v: Vendor): (PriceRow & { per1M: number })[] => priceRows(v).filter((r): r is PriceRow & { per1M: number } => r.per1M !== null)

export type Relation = 'lower' | 'higher' | 'same'
export function relation(vendorPrice: number, raPrice: number): Relation {
  const a = Math.round(vendorPrice * 1e6)
  const b = Math.round(raPrice * 1e6)
  return a < b ? 'lower' : a > b ? 'higher' : 'same'
}
export const difference = (a: number, b: number): number => Math.abs(Math.round((a - b) * 1e6)) / 1e6

/** "$15 per 1M characters" or, for a vendor that prices in other units, the vendor's own unit with no conversion. */
export function priceText(r: PriceRow): string {
  if (r.per1M !== null) return `${usd(r.per1M)} per 1M characters`
  return r.unit ? `Priced per ${r.unit.replace(/^per\s+/i, '')}; not converted` : 'No per-character price listed'
}

/** The plain statement the TTS rules require: where the vendor is lower per character than a ReadAloud tier, say so. */
export function priceStatements(v: Vendor): string[] {
  const rows = numericRows(v)
  const out: string[] = []
  if (rows.length === 0) {
    const unit = priceRows(v).map((r) => r.unit).find((u) => hasText(u))
    out.push(`${v.name} does not list a price per character that we could read. ${unit ? `It prices in a different unit (${unit}), which we show as written.` : 'We show its pricing as written.'} We have not converted it into a per-character figure, because converting needs assumptions about speaking rate that the vendor does not state, so a price comparison needs your own volume in the vendor's unit.`)
    return out
  }
  const fmt = (rs: typeof rows) => joinList(rs.map((r) => `${r.name} at ${usd(r.per1M)}`))
  const allHigherThanBoth = rows.every((r) => relation(r.per1M, RA_LIVE.per1MUsd) === 'higher' && relation(r.per1M, RA_STUDIO.per1MUsd) === 'higher')
  if (allHigherThanBoth) {
    out.push(`Every per-character list price we found for ${v.name}, ${fmt(rows)}, is higher than both ${RA_LIVE.name} (${usd(RA_LIVE.per1MUsd)}) and ${RA_STUDIO.name} (${usd(RA_STUDIO.per1MUsd)}) per 1M characters.`)
    return out
  }
  for (const tier of [RA_LIVE, RA_STUDIO]) {
    const lower = rows.filter((r) => relation(r.per1M, tier.per1MUsd) === 'lower')
    const same = rows.filter((r) => relation(r.per1M, tier.per1MUsd) === 'same')
    const higher = rows.filter((r) => relation(r.per1M, tier.per1MUsd) === 'higher')
    if (lower.length) out.push(`${poss(v.name)} ${fmt(lower)} ${lower.length > 1 ? 'are' : 'is'} lower than ${tier.name} at ${usd(tier.per1MUsd)} per 1M characters, so on list price per character ${v.name} costs less there.`)
    if (same.length) out.push(`${poss(v.name)} ${fmt(same)} ${same.length > 1 ? 'match' : 'matches'} ${tier.name} at ${usd(tier.per1MUsd)} per 1M characters.`)
    if (higher.length) out.push(`${poss(v.name)} ${fmt(higher)} ${higher.length > 1 ? 'are' : 'is'} higher than ${tier.name}.`)
  }
  return out
}

export type PriceFamily = 'per-character' | 'per-time' | 'credits-or-plan' | 'per-token' | 'other'
export function priceFamily(v: Vendor): PriceFamily {
  if (numericRows(v).length > 0) return 'per-character'
  const t = `${v.pricing.model} ${v.pricing.headline} ${v.pricing.tiers.map((x) => x.unit).join(' ')}`
  if (/credit|subscription|\bseat|\bplan\b|monthly|per month/i.test(t)) return 'credits-or-plan'
  if (/token/i.test(t)) return 'per-token'
  if (/minute|hour|second|audio/i.test(t)) return 'per-time'
  return 'other'
}

export const FAMILY_PHRASE: Record<PriceFamily, string> = {
  'per-character': 'lists a price per character',
  'per-time': 'prices by audio time',
  'credits-or-plan': 'sells plans or credits',
  'per-token': 'prices by tokens',
  other: 'prices in its own units',
}

// ---------------------------------------------------------------- formats

const FAMILY_PATTERNS: [string, RegExp][] = [
  ['mp3', /mp3/i],
  ['opus', /opus|ogg/i],
  ['wav', /wav|riff/i],
  ['pcm', /pcm|linear16|raw|l16/i],
  ['mulaw', /mu-?law|ulaw|μ-?law/i],
  ['alaw', /a-?law/i],
  ['aac', /aac/i],
  ['flac', /flac/i],
]

export function formatFamilies(formats: string[]): string[] {
  const out = new Set<string>()
  for (const f of formats) for (const [name, re] of FAMILY_PATTERNS) if (re.test(f)) out.add(name)
  return Array.from(out)
}

export function formatOverlap(v: Vendor): { shared: string[]; vendorOnly: string[] } {
  const fam = formatFamilies(v.formats)
  const ra = new Set<string>(RA_FORMATS.families)
  return { shared: fam.filter((f) => ra.has(f)), vendorOnly: fam.filter((f) => !ra.has(f)) }
}

// ---------------------------------------------------------------- which vendors get which pages

/** Vendors that get a /migrate page: active, with steps to move, capped, in priority order. A hand-written slot counts against the cap. */
export function migrationVendors(lib: Library, skip: readonly string[] = []): Vendor[] {
  const eligible = activeVendors(lib).filter((v) => v.migration.stepsToMove.length > 0)
  const rank = (s: string) => {
    const i = MIGRATE_PRIORITY.indexOf(s)
    return i === -1 ? MIGRATE_PRIORITY.length : i
  }
  const sorted = [...eligible].sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug)).slice(0, MIGRATE_CAP)
  return sorted.filter((v) => !skip.includes(v.slug))
}

/** The vendors in the migration cap including the ones with a hand-written page (for the hub). */
export function migrationSlots(lib: Library): Vendor[] {
  return migrationVendors(lib, [])
}

// ---------------------------------------------------------------- related vendors

const ADJACENT: Record<VendorCategory, VendorCategory[]> = {
  'api-platform': ['model-vendor', 'cloud-provider'],
  'cloud-provider': ['api-platform', 'model-vendor'],
  'studio-tool': ['api-platform'],
  'model-vendor': ['api-platform', 'open-source-host'],
  'open-source-host': ['model-vendor', 'api-platform'],
}

export type Related = { vendor: Vendor; why: string }
const relatedCache = new WeakMap<Library, Map<string, Related[]>>()

function relationSentence(a: Vendor, o: Vendor): string {
  const fa = priceFamily(a)
  const fo = priceFamily(o)
  const same = a.category === o.category
  const parts: string[] = []
  parts.push(
    same
      ? `${o.name} is also ${withArticle(CATEGORY_LABEL[o.category])}, and it ${FAMILY_PHRASE[fo]}${fa === fo ? ` as ${a.name} does` : `, where ${a.name} ${FAMILY_PHRASE[fa]}`}.`
      : `${o.name} is ${withArticle(CATEGORY_LABEL[o.category])} rather than ${withArticle(CATEGORY_LABEL[a.category])} like ${a.name}, and it ${FAMILY_PHRASE[fo]}${fa === fo ? ` as ${a.name} does` : `, where ${a.name} ${FAMILY_PHRASE[fa]}`}.`,
  )
  if (o.streaming.websocket === 'yes' && a.streaming.websocket !== 'yes') parts.push(`${o.name} lists WebSocket streaming.`)
  if (o.compatibility.openaiSpeechCompatible === 'yes') parts.push(`${o.name} lists an OpenAI-compatible speech endpoint.`)
  const stated = (['hipaa', 'soc2', 'gdpr'] as const).filter((k) => o.compliance[k] === 'stated')
  if (stated.length) parts.push(`Its pages mention ${joinList(stated.map((k) => (k === 'soc2' ? 'SOC 2' : k.toUpperCase())))}.`)
  return parts.join(' ')
}

/**
 * Three related options per vendor, chosen from the dataset by category, price model, an adjacent category and streaming/compat
 * overlap, with a load-balancing penalty so the same few vendors are not suggested on every page.
 */
export function relatedOptions(lib: Library, v: Vendor): Related[] {
  let table = relatedCache.get(lib)
  if (!table) {
    table = new Map()
    const active = activeVendors(lib).sort((a, b) => a.slug.localeCompare(b.slug))
    const picks = new Map<string, number>()
    for (const a of active) {
      const ranked = active
        .filter((o) => o.slug !== a.slug)
        .map((o) => {
          const score =
            (o.category === a.category ? 4 : 0) +
            (priceFamily(o) === priceFamily(a) ? 2 : 0) +
            (ADJACENT[a.category].includes(o.category) ? 1.5 : 0) +
            (o.streaming.websocket === a.streaming.websocket && o.streaming.websocket === 'yes' ? 0.5 : 0) +
            (o.compatibility.openaiSpeechCompatible === a.compatibility.openaiSpeechCompatible && a.compatibility.openaiSpeechCompatible === 'yes' ? 0.5 : 0) -
            (picks.get(o.slug) ?? 0) * 0.8 +
            (hash(`${a.slug}>${o.slug}`) % 100) / 1000
          return { o, score }
        })
        .sort((x, y) => y.score - x.score)
        .slice(0, 3)
      table.set(
        a.slug,
        ranked.map(({ o }) => {
          picks.set(o.slug, (picks.get(o.slug) ?? 0) + 1)
          return { vendor: o, why: relationSentence(a, o) }
        }),
      )
    }
    relatedCache.set(lib, table)
  }
  return table.get(v.slug) ?? []
}
