import { allPages, getLibrary, hubChildren, pageIsPublished } from './index.ts'
import { absoluteUrl } from './routes.ts'
import type { HubKey } from './pages.ts'

export type SitemapEntry = { url: string; lastModified?: string }

// Existing marketing pages. There was no sitemap before the library, so these are listed here once; add a page here when it ships.
// /developers/migrate-from-elevenlabs is the hand-written migration guide; the library never generates a duplicate of it.
export const CORE_PATHS = [
  '/', '/developers', '/developers/mcp', '/developers/migrate-from-elevenlabs', '/reader', '/transcribe', '/dub', '/audiobooks', '/design-voice', '/convert-voice', '/privacy', '/terms',
]

/**
 * Sitemap entries: the core pages plus library pages that are in src/content/publish.json. An unpublished page, and a hub with no
 * published children, is never listed (it is also noindex).
 */
export function sitemapEntries(): SitemapEntry[] {
  getLibrary()
  const out: SitemapEntry[] = CORE_PATHS.map((p) => ({ url: absoluteUrl(p) }))
  for (const p of allPages()) if (pageIsPublished(p)) out.push({ url: absoluteUrl(p.path), lastModified: p.lastVerified })
  for (const hub of ['compare', 'alternatives', 'migrate', 'integrations', 'use-cases'] as HubKey[]) if (hubChildren(hub).length > 0) out.push({ url: absoluteUrl(`/${hub}`) })
  const seen = new Set<string>()
  return out.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)))
}
