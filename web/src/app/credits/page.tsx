import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'

const URL = 'https://readaloudai.org/credits'
const TITLE = 'Credits - ReadAloud AI'
const DESCRIPTION = 'The openly licensed datasets some ReadAloud AI voices were trained on, credited to their authors.'

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { title: TITLE, description: DESCRIPTION, url: URL, siteName: 'ReadAloud AI', type: 'article' },
}

type Row = { name: string; use: string; licence: string; href: string }

const data: Row[] = [
  { name: 'CML-TTS', use: 'Training data for the Spanish voice (ReadAloud app and dubbing)', licence: 'CC BY 4.0', href: 'https://www.openslr.org/146/' },
  { name: 'LibriTTS-R', use: 'Base data for the Spanish voice (ReadAloud app and dubbing)', licence: 'CC BY 4.0', href: 'https://www.openslr.org/141/' },
  { name: 'Multilingual LibriSpeech (MLS)', use: 'Training data for French dubbing voices', licence: 'CC BY 4.0', href: 'https://www.openslr.org/94/' },
]

function Table({ rows, first }: { rows: Row[]; first: string }) {
  return (
    <div className="ra-table-wrap">
      <table className="ra-table">
        <thead><tr><th>{first}</th><th>Used for</th><th>Licence</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td><a href={r.href} rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>{r.name}</a></td>
              <td>{r.use}</td>
              <td>{r.licence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CreditsPage() {
  return (
    <div className="ra">
      <RaHeader />
      <main>
        <section className="ra-hero" style={{ paddingBottom: 32 }}>
          <div className="ra-wrap">
            <h1 style={{ maxWidth: '18ch' }}>Credits</h1>
            <p className="ra-lede">
              Some ReadAloud voices were trained on openly licensed datasets. Thank you to their authors. Licences are the ones the datasets publish; follow the links for the full terms.
            </p>
          </div>
        </section>

        <section className="ra-section" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 820 }}>
            <h2>Datasets</h2>
            <p className="ra-small" style={{ marginBottom: 12 }}>
              CC BY 4.0 requires attribution: CML-TTS, LibriTTS-R and Multilingual LibriSpeech are credited to their authors at the links below.
            </p>
            <Table rows={data} first="Dataset" />
          </div>
        </section>
      </main>
      <RaFooter />
    </div>
  )
}
