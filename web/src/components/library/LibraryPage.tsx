import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import type { Block, Crumb, HubModel, LibraryPageModel } from '@/lib/seoLibrary/model'
import { breadcrumbJsonLd, faqJsonLd, jsonLdString } from '@/lib/seoLibrary/seo'
import { longDate } from '@/lib/seoLibrary/helpers'

// Server-rendered, no client JavaScript: everything on a library page is plain HTML. The blocks come from src/lib/seoLibrary/pages.ts;
// the validator reads the same blocks, so the text it checks is the text rendered here. Light-only, styled with the .ra marketing classes.

const EXT_REL = 'noopener noreferrer nofollow'
const underline = { textDecoration: 'underline' } as const

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'source'
  }
}

function SourceLink({ url }: { url?: string }) {
  if (!url) return null
  return (
    <>
      {' '}
      <a href={url} rel={EXT_REL} className="ra-lib-src" style={underline}>
        (source: {host(url)})
      </a>
    </>
  )
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="ra-crumbs">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.path}>{i === crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <Link href={c.path}>{c.name}</Link>}</li>
        ))}
      </ol>
    </nav>
  )
}

function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case 'h2':
      return <h2 id={b.id}>{b.text}</h2>
    case 'h3':
      return <h3>{b.text}</h3>
    case 'verified':
      return <p className="ra-pill">{b.text}</p>
    case 'p':
      return b.tone === 'note' ? <p className="ra-lib-note">{b.text}</p> : <p>{b.text}</p>
    case 'list': {
      const L = b.ordered ? 'ol' : 'ul'
      return (
        <L>
          {b.items.map((i, n) => (
            <li key={n}>
              {i.text}
              <SourceLink url={i.sourceUrl} />
            </li>
          ))}
        </L>
      )
    }
    case 'table':
      return (
        <div className="ra-table-wrap">
          <table className="ra-table">
            <caption style={{ position: 'absolute', left: -9999 }}>{b.caption}</caption>
            <thead>
              <tr>
                {b.columns.map((c, i) => (
                  <th key={i} scope="col">
                    {c || <span style={{ position: 'absolute', left: -9999 }}>Topic</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) =>
                    ci === 0 ? (
                      <th key={ci} scope="row">
                        {c.text}
                      </th>
                    ) : (
                      <td key={ci}>
                        {c.text}
                        <SourceLink url={c.sourceUrl} />
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'cards':
      return (
        <ul className="ra-lib-cards">
          {b.items.map((c, i) => (
            <li key={i}>
              <h3>
                {c.href ? (
                  c.external ? (
                    <a href={c.href} rel={EXT_REL} style={underline}>
                      {c.title}
                    </a>
                  ) : (
                    <Link href={c.href} style={underline}>
                      {c.title}
                    </Link>
                  )
                ) : (
                  c.title
                )}
              </h3>
              <p>{c.text}</p>
              {c.meta && (
                <p className="meta">
                  {c.meta}
                  <SourceLink url={c.sourceUrl} />
                </p>
              )}
            </li>
          ))}
        </ul>
      )
    case 'links':
      return (
        <nav aria-label={b.title} className="ra-lib-links">
          <p>{b.title}</p>
          <ul>
            {b.items.map((l) => (
              <li key={l.href}>
                {l.external ? (
                  <a href={l.href} rel={EXT_REL} style={underline}>
                    {l.label}
                  </a>
                ) : (
                  <Link href={l.href} style={underline}>
                    {l.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      )
    case 'faq':
      return (
        <dl className="ra-lib-faq">
          {b.items.map((f, i) => (
            <div key={i}>
              <dt>{f.q}</dt>
              <dd>{f.a}</dd>
            </div>
          ))}
        </dl>
      )
    case 'sources':
      return (
        <ul>
          {b.items.map((s) => (
            <li key={s.url}>
              <a href={s.url} rel={EXT_REL} style={underline}>
                {s.title}
              </a>
              <span className="ra-lib-src"> (retrieved {longDate(s.retrievedAt)})</span>
            </li>
          ))}
        </ul>
      )
    case 'code':
      return (
        <div className="ra-lib-code">
          {b.caption && <div className="cap">{b.caption}</div>}
          <pre>
            <code>{b.code}</code>
          </pre>
        </div>
      )
    case 'example':
      return (
        <div className="ra-lib-example">
          <b>{b.title}</b>
          <blockquote>{b.input}</blockquote>
          {b.notes && <p>{b.notes}</p>}
        </div>
      )
  }
}

function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />
}

function Hero({ m, preview }: { m: LibraryPageModel | HubModel; preview: boolean }) {
  return (
    <section className="ra-lib-hero">
      <div className="ra-wrap">
        <Breadcrumbs crumbs={m.breadcrumbs} />
        {preview && (
          <p role="note" className="ra-preview">
            Preview: this page is not published yet, so search engines are told not to index it.
          </p>
        )}
        <h1>{m.h1}</h1>
        <p className="ra-lede">{m.lede}</p>
      </div>
    </section>
  )
}

export function LibraryPageView({ page, indexed }: { page: LibraryPageModel; indexed: boolean }) {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <JsonLd data={breadcrumbJsonLd(page.breadcrumbs)} />
        {page.faqJsonLd && <JsonLd data={faqJsonLd(page.faqJsonLd)} />}
        <Hero m={page} preview={!indexed} />
        <div className="ra-lib">
          <div className="ra-wrap">
            <article className="ra-lib-body">
              {page.blocks.map((b, i) => (
                <BlockView key={i} b={b} />
              ))}
            </article>
          </div>
        </div>
      </main>
      <RaFooter />
    </div>
  )
}

export type HubItem = { href: string; title: string; text: string }

export function HubView({ hub, items, indexed, emptyNote }: { hub: HubModel; items: HubItem[]; indexed: boolean; emptyNote: string }) {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <JsonLd data={breadcrumbJsonLd(hub.breadcrumbs)} />
        <Hero m={hub} preview={!indexed} />
        <div className="ra-lib">
          <div className="ra-wrap">
            {items.length === 0 ? (
              <p className="ra-lede">{emptyNote}</p>
            ) : (
              <ul className="ra-lib-hub">
                {items.map((i) => (
                  <li key={i.href}>
                    <Link href={i.href}>
                      <b>{i.title}</b>
                      <span>{i.text}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
      <RaFooter />
    </div>
  )
}
