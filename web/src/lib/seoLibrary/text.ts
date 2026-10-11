import type { Block, LibraryPageModel } from './model.ts'

/** The visible text of a block list, one line per element. Used by every validator check so they read what visitors read. */
export function textOfBlocks(blocks: Block[], opts: { skip?: Block['kind'][] } = {}): string {
  const out: string[] = []
  for (const b of blocks) {
    if (opts.skip?.includes(b.kind)) continue
    switch (b.kind) {
      case 'h2':
      case 'h3':
      case 'p':
      case 'verified':
        out.push(b.text)
        break
      case 'list':
        for (const i of b.items) out.push(i.text)
        break
      case 'table':
        out.push(b.caption, b.columns.join(' | '))
        for (const r of b.rows) out.push(r.map((c) => c.text).join(' | '))
        break
      case 'cards':
        for (const c of b.items) out.push(`${c.title}. ${c.text}${c.meta ? ` ${c.meta}` : ''}`)
        break
      case 'links':
        out.push(b.title, ...b.items.map((i) => i.label))
        break
      case 'faq':
        for (const f of b.items) out.push(f.q, f.a)
        break
      case 'sources':
        for (const s of b.items) out.push(`${s.title} (retrieved ${s.retrievedAt})`)
        break
      case 'code':
        out.push(b.caption ?? '', b.code)
        break
      case 'example':
        out.push(b.title, b.input, b.notes ?? '')
        break
    }
  }
  return out.join('\n')
}

/** Headline, lede and body: everything a page says. */
export function textOfPage(p: LibraryPageModel, opts: { skip?: Block['kind'][] } = {}): string {
  return [p.h1, p.lede, textOfBlocks(p.blocks, opts)].join('\n')
}

export function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9'$%.\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean)
}

export function wordCount(text: string): number {
  return wordsOf(text).length
}
