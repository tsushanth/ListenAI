// The page model. Every page is built as an ordered list of blocks. The React renderer (src/components/library/LibraryPage.tsx)
// and the validator's plain-text extraction (textOfBlocks in text.ts) both read the same blocks, so what the validator checks is
// exactly what a visitor reads.

export type PageType = 'compare' | 'alternatives' | 'migrate' | 'integration' | 'use-case'
export type HubType = 'compare' | 'alternatives' | 'migrate' | 'integrations' | 'use-cases'

export type Cell = { text: string; sourceUrl?: string }
export type Block =
  | { kind: 'h2'; text: string; id?: string }
  | { kind: 'h3'; text: string }
  | { kind: 'p'; text: string; tone?: 'note' }
  | { kind: 'verified'; text: string }
  | { kind: 'list'; ordered?: boolean; items: { text: string; sourceUrl?: string }[] }
  | { kind: 'table'; caption: string; columns: string[]; rows: Cell[][] }
  | { kind: 'cards'; items: { title: string; text: string; href?: string; external?: boolean; meta?: string; sourceUrl?: string }[] }
  | { kind: 'links'; title: string; items: { label: string; href: string; external?: boolean }[] }
  | { kind: 'faq'; items: { q: string; a: string }[] }
  | { kind: 'sources'; items: { title: string; url: string; retrievedAt: string }[] }
  /** Code is shown to readers but never counts toward word count or similarity, so it cannot pad a thin page. */
  | { kind: 'code'; language: string; code: string; caption?: string }
  /** A sample text for a use case: the input a reader would send, plus notes. Text only; no audio claim. */
  | { kind: 'example'; title: string; input: string; notes?: string }

export type Crumb = { name: string; path: string }

export type LibraryPageModel = {
  type: PageType
  /** The content slug (vendor, use case or integration). */
  slug: string
  /** Publish-list key, e.g. "compare:elevenlabs". */
  key: string
  path: string
  title: string
  description: string
  h1: string
  lede: string
  breadcrumbs: Crumb[]
  blocks: Block[]
  /** Vendor pages: the vendor, used by the validator to attribute sentences. */
  vendorSlug?: string
  vendorName?: string
  /** Latest retrievedAt used on the page (vendor pages). */
  lastVerified?: string
  /** Use-case and integration pages render this as FAQPage JSON-LD. Vendor pages never do. */
  faqJsonLd?: { q: string; a: string }[]
}

export type HubModel = {
  type: HubType
  path: string
  title: string
  description: string
  h1: string
  lede: string
  breadcrumbs: Crumb[]
}

export const VENDOR_PAGE_TYPES: PageType[] = ['compare', 'alternatives', 'migrate']
export const isVendorType = (t: PageType) => VENDOR_PAGE_TYPES.includes(t)
