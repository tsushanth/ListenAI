import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'
import ConsentClient from '@/components/ra/ConsentClient'
import { validateAuthorize, buildRedirect } from '@/lib/oauth/authorize'
import { oauthConfigured } from '@/lib/oauth/crypto'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Connect an app - ReadAloud AI', robots: { index: false } }

export default function ConsentPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) if (typeof v === 'string') q.set(k, v)
  const v = oauthConfigured() ? validateAuthorize(q) : ({ ok: false, message: 'OAuth is not configured on this server.' } as const)
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 56 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 560 }}>
            {v.ok ? (
              <ConsentClient
                clientName={v.p.clientName}
                params={q.toString()}
                cancelUrl={buildRedirect(v.p.redirectUri, { error: 'access_denied', state: v.p.state })}
              />
            ) : (
              <>
                <h1 style={{ fontSize: '1.8rem' }}>We could not start this connection</h1>
                <p className="ra-lede">{v.message}</p>
                <p>Nothing was connected. Go back to the app you were connecting and try again.</p>
              </>
            )}
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
