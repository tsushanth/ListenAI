import Link from 'next/link'
import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'

/** The page of a feature that is switched off: says so plainly and points to what does work. */
export default function FeatureUnavailable({ title, message, alternative }: { title: string; message: string; alternative: { href: string; label: string } }) {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 12, maxWidth: '22ch' }}>{title}</h1>
            <p className="ra-lede" style={{ fontSize: '1.1rem', marginBottom: 20, maxWidth: '50ch' }} role="status">{message}</p>
            <p><Link href={alternative.href} style={{ textDecoration: 'underline' }}>{alternative.label}</Link></p>
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
