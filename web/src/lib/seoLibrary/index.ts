import { loadLibrary, type Library } from './load.ts'
import { migrationVendors } from './vendor.ts'
import { hubModels, type HubKey } from './pages.ts'
import { formatIssues, keySlug, keyType, validateLibrary, type Issue, type ValidationResult } from './validate.ts'
import { isPublished } from './publish.ts'
import type { HubModel, LibraryPageModel, PageType } from './model.ts'
import { HAND_WRITTEN_MIGRATIONS, slugFromSegment } from './routes.ts'

// The entry point for routes and the sitemap. Content is read once per process (at build time for statically generated pages).
//
// Build gate: during `next build`, a schema error always fails the build (load.ts), and so does any validation ERROR that belongs to a
// PUBLISHED page or to a vendor/use case/integration whose pages are published. Errors on unpublished pages are reported by the test
// suite (test/seoLibrary) but do not stop a deploy, because those pages are noindex and unlinked.

let cache: { lib: Library; result: ValidationResult } | null = null

function affectsPublished(lib: Library, i: Issue): boolean {
  if (i.key) return isPublished(lib.publish, keyType(i.key), keySlug(i.key))
  const m = /^(vendors|use-cases|integrations)\/(.+)$/.exec(i.where)
  if (m) {
    const slug = m[2]
    if (m[1] === 'vendors') return (['compare', 'alternatives', 'migrate'] as PageType[]).some((t) => isPublished(lib.publish, t, slug))
    return isPublished(lib.publish, m[1] === 'use-cases' ? 'use-case' : 'integration', slug)
  }
  return i.where === 'publish.json'
}

export function getLibrary(): { lib: Library; result: ValidationResult } {
  if (cache) return cache
  const lib = loadLibrary()
  const result = validateLibrary(lib)
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    const blocking = result.errors.filter((i) => affectsPublished(lib, i))
    if (blocking.length) throw new Error(`Library validation failed for published content:\n${formatIssues(blocking)}`)
  }
  cache = { lib, result }
  return cache
}

export function resetLibraryCache() {
  cache = null
}

/** Tests: serve a library built in memory instead of reading src/content. */
export function setLibraryForTests(lib: Library | null, opts: { checkRelated?: boolean } = {}) {
  cache = lib ? { lib, result: validateLibrary(lib, new Date(), opts) } : null
}

export function allPages(): LibraryPageModel[] {
  return getLibrary().result.pages
}

export function pagesOfType(type: PageType): LibraryPageModel[] {
  return allPages().filter((p) => p.type === type)
}

export function findPage(type: PageType, segment: string): LibraryPageModel | undefined {
  const slug = type === 'integration' || type === 'use-case' ? segment : slugFromSegment(type, segment)
  return slug ? allPages().find((p) => p.type === type && p.slug === slug) : undefined
}

export function pageIsPublished(p: LibraryPageModel): boolean {
  const { lib } = getLibrary()
  return isPublished(lib.publish, p.type, p.slug)
}

export function publishedPages(): LibraryPageModel[] {
  return allPages().filter(pageIsPublished)
}

const HUB_TYPES: Record<HubKey, PageType> = { compare: 'compare', alternatives: 'alternatives', migrate: 'migrate', integrations: 'integration', 'use-cases': 'use-case' }

export function hubChildren(hub: HubKey): LibraryPageModel[] {
  return publishedPages().filter((p) => p.type === HUB_TYPES[hub])
}

/** A hub is indexable once at least one child is published. */
export function hubModel(hub: HubKey): { model: HubModel; children: LibraryPageModel[]; indexed: boolean } {
  const children = hubChildren(hub)
  return { model: hubModels()[hub], children, indexed: children.length > 0 }
}

/** The /migrate hub also lists vendors whose guide is a hand-written page (always live) when that vendor is in the dataset and has steps. */
export function handWrittenMigrations(): { slug: string; href: string; label: string }[] {
  const { lib } = getLibrary()
  const inCap = new Set(migrationVendors(lib).map((v) => v.slug))
  return Object.entries(HAND_WRITTEN_MIGRATIONS).filter(([slug]) => inCap.has(slug)).map(([slug, h]) => ({ slug, ...h }))
}

export { migrationVendors }
