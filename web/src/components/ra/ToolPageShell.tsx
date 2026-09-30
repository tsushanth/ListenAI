import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'

// Server-component page frame shared by the tool pages; mirrors convert-voice/page.tsx.
export default function ToolPageShell({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string
  title: string
  lede: string
  children: React.ReactNode
}) {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-section" style={{ paddingTop: 48, minHeight: '70vh' }}>
          <div className="ra-wrap">
            <p className="ra-small" style={{ marginBottom: 8 }}>{eyebrow}</p>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', marginBottom: 12, maxWidth: '22ch' }}>{title}</h1>
            <p className="ra-lede" style={{ fontSize: '1.1rem', marginBottom: 28, maxWidth: '50ch' }}>{lede}</p>
            {children}
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
