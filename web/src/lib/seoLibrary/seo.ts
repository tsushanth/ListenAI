import type { Metadata } from 'next'
import type { Crumb, HubModel, LibraryPageModel } from './model.ts'
import { SITE_URL, absoluteUrl } from './routes.ts'

/** Metadata for a library page or hub: unique title and description, canonical, OpenGraph, and noindex until published. */
export function metadataFor(m: LibraryPageModel | HubModel, indexed: boolean): Metadata {
  const url = absoluteUrl(m.path)
  return {
    title: { absolute: m.title },
    description: m.description,
    alternates: { canonical: url },
    openGraph: { title: m.title, description: m.description, url, type: 'article', siteName: 'ReadAloud AI' },
    twitter: { card: 'summary', title: m.title, description: m.description },
    // Unpublished pages render for preview but must not be indexed. Next renders this as <meta name="robots" content="noindex">.
    robots: indexed ? undefined : { index: false },
  }
}

export function breadcrumbJsonLd(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.path === '/' ? SITE_URL : `${SITE_URL}${c.path}` })),
  }
}

/** Plain FAQPage markup. Only use-case and integration pages use it, and only for questions that are visible on the page. */
export function faqJsonLd(items: { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({ '@type': 'Question', name: i.q, acceptedAnswer: { '@type': 'Answer', text: i.a } })),
  }
}

/** JSON for a <script type="application/ld+json"> tag, with "<" escaped so page text can never close the tag. */
export function jsonLdString(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}
