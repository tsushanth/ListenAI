import { z } from 'zod'

// Schemas for the programmatic content library. The JSON files in src/content/{vendors,use-cases,integrations} are written by
// researchers and content writers; these schemas are the contract. A file that does not match fails the build (see load.ts), so a
// page can never render from half-shaped data.
//
// The schemas check SHAPE and tolerate how researchers write "unknown": null, an empty string and a missing key all mean "not stated"
// and are normalised here (the Calldesk library once rejected a whole file because one nullable field arrived as null). Counts,
// lengths and minimum word counts are NOT checked here; they are validator rules (validate.ts), so a file that is a little short
// blocks only its own page from being published, not the whole build.
//
// Public repo: nothing private, no costs or margins, in any content file.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'not a real date')
const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens only')
const text = z.string().trim().min(1, 'must not be empty')

/** A string that may be missing, null or empty: all become ''. Numbers and booleans are written out as text. */
const loose = z
  .union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()])
  .transform((v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v).trim()))
/** A URL that may be missing, null or empty: becomes undefined. */
const optUrl = z.union([httpUrl, z.literal(''), z.null(), z.undefined()]).transform((v) => (v ? v : undefined))
/** An array that may be null or missing. */
const list = <T extends z.ZodTypeAny>(item: T) => z.union([z.array(item), z.null(), z.undefined()]).transform((v) => v ?? [])
/** A number that may be null or missing; anything else non-numeric is rejected. */
const nullableNumber = z.union([z.number().nonnegative(), z.null(), z.undefined()]).transform((v) => (v === undefined ? null : v))
/** 'yes' | 'no' | 'unknown', also accepting booleans and null. */
const ynu = z
  .union([z.enum(['yes', 'no', 'unknown']), z.boolean(), z.null(), z.undefined()])
  .transform((v): 'yes' | 'no' | 'unknown' => (v === true ? 'yes' : v === false ? 'no' : v === 'yes' || v === 'no' ? v : 'unknown'))
const stated = z.union([z.enum(['stated', 'not-stated']), z.null(), z.undefined()]).transform((v): 'stated' | 'not-stated' => (v === 'stated' ? 'stated' : 'not-stated'))

export const SourcedClaim = z.object({ claim: text, sourceUrl: httpUrl })

export const PRICING_CATEGORIES = ['api-platform', 'cloud-provider', 'studio-tool', 'model-vendor', 'open-source-host'] as const
export type VendorCategory = (typeof PRICING_CATEGORIES)[number]

export const VendorSchema = z.object({
  slug,
  name: text,
  url: httpUrl,
  status: z.enum(['active', 'unclear', 'inactive']),
  retrievedAt: isoDate,
  category: z.enum(PRICING_CATEGORIES),
  positioning: text,
  pricing: z.object({
    model: text,
    headline: loose,
    pricePer1MCharsUsd: nullableNumber,
    headlineTier: loose,
    tiers: list(z.object({ name: text, pricePer1MCharsUsd: nullableNumber, unit: loose, notes: loose })),
    freeTier: loose,
    promotions: list(text),
    sourceUrls: list(httpUrl),
  }),
  voices: z.object({ count: loose, languages: z.union([z.string(), z.array(z.string()), z.number(), z.null(), z.undefined()]).transform((v) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v).trim())), customVoiceOrCloning: loose, sourceUrl: optUrl }),
  streaming: z.object({ websocket: ynu, http: ynu, vendorStatedLatency: loose, sourceUrl: optUrl }),
  formats: list(text),
  ssml: ynu,
  compatibility: z.object({ openaiSpeechCompatible: ynu, note: loose }),
  licensing: z.object({ commercialUse: loose, attributionOrConditions: loose, sourceUrl: optUrl }),
  limits: z.object({ perRequestCharacters: loose, concurrency: loose, sourceUrl: optUrl }),
  sdks: list(text),
  compliance: z.object({ hipaa: stated, soc2: stated, gdpr: stated, note: loose, sourceUrl: optUrl }),
  strengths: list(SourcedClaim),
  limitations: list(SourcedClaim),
  migration: z.object({ stepsToMove: list(text), sourceUrls: list(httpUrl) }),
  bestFor: loose,
  sources: z.array(z.object({ url: httpUrl, title: text, retrievedAt: isoDate })).min(1),
  unknowns: list(text),
})
export type Vendor = z.infer<typeof VendorSchema>

const faq = list(z.object({ q: text, a: text }))

export const UseCaseSchema = z.object({
  slug,
  name: text,
  h1: text,
  metaDescription: text,
  intro: text,
  steps: list(text),
  sampleExample: z.object({ title: text, input: text, notes: loose }),
  whenToChooseReadAloud: list(text),
  whenToChooseSomethingElse: list(text),
  featuresUsed: list(z.object({ feature: text, howItHelps: text })),
  considerations: list(text),
  faq,
  relatedSlugs: list(slug),
})
export type UseCase = z.infer<typeof UseCaseSchema>

export const IntegrationSchema = z.object({
  slug,
  name: text,
  h1: text,
  metaDescription: text,
  intro: text,
  install: loose,
  quickstart: z.object({ language: text, code: text }),
  verifiedWith: z.object({ packageOrSdk: text, version: loose, date: isoDate }),
  whatWorks: list(text),
  limitations: list(text),
  links: list(z.object({ label: text, url: httpUrl })),
  faq,
  relatedSlugs: list(slug),
})
export type Integration = z.infer<typeof IntegrationSchema>

/** Entries: a bare slug (every page that slug can have), or "<kind>:<slug>" with kind compare | alternatives | migrate | integrations | use-cases. */
export const PublishSchema = z.object({ published: z.array(z.string().regex(/^(?:(?:compare|alternatives|migrate|integrations|use-cases):)?[a-z0-9]+(?:-[a-z0-9]+)*$/)) })
export type PublishList = z.infer<typeof PublishSchema>
