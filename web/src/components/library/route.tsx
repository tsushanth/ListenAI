import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { LibraryPageView, HubView, type HubItem } from '@/components/library/LibraryPage'
import { findPage, handWrittenMigrations, hubModel, pageIsPublished, pagesOfType } from '@/lib/seoLibrary'
import { metadataFor } from '@/lib/seoLibrary/seo'
import type { LibraryPageModel, PageType } from '@/lib/seoLibrary/model'
import type { HubKey } from '@/lib/seoLibrary/pages'

// Shared by the /compare, /alternatives, /migrate, /integrations and /use-cases routes.

export const segmentOf = (p: LibraryPageModel) => p.path.split('/').pop() as string

/** Every page is generated at build time (published or not); an unknown segment is a 404 (dynamicParams = false in each route). */
export function staticSegments(type: PageType): { slug: string }[] {
  return pagesOfType(type).map((p) => ({ slug: segmentOf(p) }))
}

export function pageMetadata(type: PageType, params: { slug: string }): Metadata {
  const page = findPage(type, params.slug)
  if (!page) return {}
  return metadataFor(page, pageIsPublished(page))
}

export function PageRoute({ type, params }: { type: PageType; params: { slug: string } }) {
  const page = findPage(type, params.slug)
  if (!page) notFound()
  return <LibraryPageView page={page} indexed={pageIsPublished(page)} />
}

const HUB_EMPTY: Record<HubKey, string> = {
  compare: 'The first comparison pages are being reviewed and will be listed here when they are published.',
  alternatives: 'The first alternatives guides are being reviewed and will be listed here when they are published.',
  migrate: 'The first migration guides are being reviewed and will be listed here when they are published.',
  integrations: 'The first integration pages are being reviewed and will be listed here when they are published.',
  'use-cases': 'The first use-case pages are being reviewed and will be listed here when they are published.',
}

export function hubMetadata(hub: HubKey): Metadata {
  const h = hubModel(hub)
  return metadataFor(h.model, h.indexed)
}

export function HubRoute({ hub }: { hub: HubKey }) {
  const h = hubModel(hub)
  const items: HubItem[] = h.children.map((p) => ({ href: p.path, title: p.h1, text: p.lede.length > 150 ? `${p.lede.slice(0, 147).trimEnd()}...` : p.lede }))
  if (hub === 'migrate') {
    // The hand-written ElevenLabs guide is always live, so it is always listed once the dataset includes that vendor.
    for (const w of handWrittenMigrations()) items.unshift({ href: w.href, title: w.label, text: 'The hand-written guide, with what we tested against the live API on a stated date and what is not supported.' })
  }
  return <HubView hub={h.model} items={items} indexed={h.indexed} emptyNote={HUB_EMPTY[hub]} />
}
