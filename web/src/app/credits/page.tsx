import RaHeader from '@/components/ra/RaHeader'
import RaFooter from '@/components/ra/RaFooter'

const URL = 'https://readaloudai.org/credits'
const TITLE = 'Open-source credits - ReadAloud AI'
const DESCRIPTION = 'The open-source models, libraries and datasets ReadAloud AI builds on, with their licences.'

export const metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { title: TITLE, description: DESCRIPTION, url: URL, siteName: 'ReadAloud AI', type: 'article' },
}

type Row = { name: string; use: string; licence: string; href: string }

const software: Row[] = [
  { name: 'Kokoro-82M', use: 'Text-to-speech model', licence: 'Apache License 2.0', href: 'https://huggingface.co/hexgrad/Kokoro-82M' },
  { name: 'misaki', use: 'Text-to-phoneme front end for speech synthesis', licence: 'Apache License 2.0', href: 'https://github.com/hexgrad/misaki' },
  { name: 'Piper', use: 'Text-to-speech engine', licence: 'GNU GPL v3.0', href: 'https://github.com/OHF-Voice/piper1-gpl' },
  { name: 'eSpeak NG', use: 'Pronunciation (phonemisation) for speech synthesis', licence: 'GNU GPL v3.0', href: 'https://github.com/espeak-ng/espeak-ng' },
  { name: 'Chatterbox', use: 'Voice cloning from a reference recording', licence: 'MIT', href: 'https://github.com/resemble-ai/chatterbox' },
  { name: 'Orpheus TTS', use: 'The second, streaming voice-cloning path', licence: 'Apache License 2.0', href: 'https://github.com/canopyai/Orpheus-TTS' },
  { name: 'Whisper large-v3-turbo', use: 'Speech to text and the transcription step of dubbing', licence: 'MIT', href: 'https://huggingface.co/openai/whisper-large-v3-turbo' },
  { name: 'Demucs', use: 'Voice isolation', licence: 'MIT', href: 'https://github.com/facebookresearch/demucs' },
]

const data: Row[] = [
  { name: 'CML-TTS', use: 'Training data for Spanish dubbing voices', licence: 'CC BY 4.0', href: 'https://www.openslr.org/146/' },
  { name: 'LibriTTS-R', use: 'Base data for Spanish dubbing voices', licence: 'CC BY 4.0', href: 'https://www.openslr.org/141/' },
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
            <h1 style={{ maxWidth: '18ch' }}>Open-source credits</h1>
            <p className="ra-lede">
              ReadAloud builds on the work of open-source projects. Thank you to their authors. Licences are the ones the projects publish; follow the links for the full terms.
            </p>
          </div>
        </section>

        <section className="ra-section" style={{ paddingTop: 40 }}>
          <div className="ra-wrap ra-narrow" style={{ maxWidth: 820 }}>
            <h2>Models and software</h2>
            <Table rows={software} first="Project" />

            <h2 style={{ marginTop: 40 }}>Datasets</h2>
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
