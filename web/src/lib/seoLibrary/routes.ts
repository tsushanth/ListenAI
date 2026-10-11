import { RA_SITE } from '../../content/readaloudFacts.ts'
import type { PageType } from './model.ts'

// URL scheme. Paths are built here and nowhere else.
export const SITE_URL = RA_SITE

export const compareSlug = (v: string) => `readaloud-vs-${v}`
export const alternativesSlug = (v: string) => `${v}-alternatives`
export const migrateSlug = (v: string) => `from-${v}`

export const paths = {
  compare: (v: string) => `/compare/${compareSlug(v)}`,
  alternatives: (v: string) => `/alternatives/${alternativesSlug(v)}`,
  migrate: (v: string) => `/migrate/${migrateSlug(v)}`,
  integration: (s: string) => `/integrations/${s}`,
  useCase: (s: string) => `/use-cases/${s}`,
}

export const pathFor = (type: PageType, slug: string): string =>
  type === 'compare' ? paths.compare(slug) : type === 'alternatives' ? paths.alternatives(slug) : type === 'migrate' ? paths.migrate(slug) : type === 'integration' ? paths.integration(slug) : paths.useCase(slug)

export const absoluteUrl = (p: string) => `${SITE_URL}${p}`

/** Turn a URL segment back into a content slug (null when it does not match the route's pattern). */
export function slugFromSegment(type: PageType, segment: string): string | null {
  const pre = type === 'compare' ? 'readaloud-vs-' : type === 'migrate' ? 'from-' : ''
  const suf = type === 'alternatives' ? '-alternatives' : ''
  if (!segment.startsWith(pre) || !segment.endsWith(suf)) return null
  const s = segment.slice(pre.length, segment.length - suf.length)
  return s || null
}

/** The order migration pages are built in; capped. Vendors outside this list fill any remaining places alphabetically. */
export const MIGRATE_PRIORITY = ['elevenlabs', 'openai-tts', 'google-cloud-tts', 'amazon-polly', 'azure-ai-speech', 'cartesia', 'deepgram-aura', 'play-ai', 'lmnt', 'rime', 'murf-ai', 'unreal-speech']
export const MIGRATE_CAP = 12

/**
 * Vendors that already have a hand-written migration page. The library does not generate /migrate/from-<slug> for them (it would
 * duplicate that page); the /migrate hub and the vendor's compare and alternatives pages link to the hand-written page instead.
 * The slot still counts against MIGRATE_CAP, so the hub never lists more than 12 guides in all.
 */
export const HAND_WRITTEN_MIGRATIONS: Readonly<Record<string, { href: string; label: string }>> = {
  elevenlabs: { href: '/developers/migrate-from-elevenlabs', label: 'Migrate from ElevenLabs' },
}
