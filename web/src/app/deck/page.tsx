// Public one-page pitch deck for platforms that run their own voice stack. Linked from outreach emails; no internal notes.
// Prices read from public pricing pages in October 2026. Do not name the underlying voice models or competitors here.
export const metadata = {
  title: 'ReadAloud AI - a lower-cost voice layer for platforms',
  description: 'Text to speech from $0.004 per 1,000 characters and speech to text at $0.11 per hour. Hear it, see the numbers.',
  robots: { index: false, follow: false },
}

const R = 120
const C = 2 * Math.PI * R
const COLORS = { tts: '#2F5BEA', phone: '#7A8497', stt: '#C98B2B', llm: '#3A9D8F' } as const
const LABELS = { tts: 'Text to speech', phone: 'Phone line', stt: 'Speech to text', llm: 'Language model' } as const
type Part = keyof typeof COLORS
type Slice = [Part, number]

// Share of the cost of one minute of a call: phone line $0.0085, speech to text $0.0065, language model $0.0065, plus voice.
const premium: Slice[] = [['tts', 0.044 / 0.0655], ['phone', 0.0085 / 0.0655], ['stt', 0.0065 / 0.0655], ['llm', 0.0065 / 0.0655]]
const ours: Slice[] = [['tts', 0.0022 / 0.0237], ['phone', 0.0085 / 0.0237], ['stt', 0.0065 / 0.0237], ['llm', 0.0065 / 0.0237]]

function Donut({ data, big, label }: { data: Slice[]; big: string; label: string }) {
  let off = 0
  return (
    <div className="dk-donut">
      <svg width="300" height="300" viewBox="0 0 360 360" role="img" aria-label={label}>
        {data.map(([k, v]) => {
          const len = v * C
          const el = (
            <circle key={k} cx="180" cy="180" r={R} fill="none" stroke={COLORS[k]} strokeWidth="60"
              strokeDasharray={`${len.toFixed(2)} ${(C - len).toFixed(2)}`} strokeDashoffset={(-off).toFixed(2)} transform="rotate(-90 180 180)" />
          )
          off += len
          return el
        })}
      </svg>
      <p className="dk-donut-big">{big}</p>
    </div>
  )
}

function Legend({ data }: { data: Slice[] }) {
  return (
    <ul className="dk-legend">
      {data.map(([k, v]) => (
        <li key={k} style={k === 'tts' ? { fontWeight: 700 } : undefined}>
          <span style={{ background: COLORS[k] }} />
          {LABELS[k]} {Math.round(v * 100)}%
        </li>
      ))}
    </ul>
  )
}

export default function DeckPage() {
  return (
    <div className="dk">
      <style>{CSS}</style>

      <section className="dk-s dk-dark">
        <div className="dk-wrap">
          <p className="dk-eyebrow">ReadAloud AI</p>
          <h1>A lower-cost voice layer for platforms that run their own stack</h1>
          <p className="dk-sub">Text to speech and speech to text over an API. Prices read in October 2026.</p>
          <p className="dk-hint">Scroll to read, or jump to <a href="#hear">hear it</a>.</p>
        </div>
      </section>

      <section className="dk-s dk-light">
        <div className="dk-wrap">
          <h2>Voice is the biggest line in the cost of a call</h2>
          <div className="dk-cards">
            <div className="dk-card">
              <h3>A premium voice, $0.08 per 1,000 characters</h3>
              <div className="dk-row">
                <Donut data={premium} big="67%" label="Donut chart: text to speech is 67 percent of the cost of a call minute on a premium voice" />
                <Legend data={premium} />
              </div>
              <p className="dk-cap">$0.0655 per minute of a call</p>
            </div>
            <div className="dk-card">
              <h3>ReadAloud standard voices, $0.004 per 1,000 characters</h3>
              <div className="dk-row">
                <Donut data={ours} big="9%" label="Donut chart: text to speech is 9 percent of the cost of a call minute with ReadAloud standard voices" />
                <Legend data={ours} />
              </div>
              <p className="dk-cap">$0.0237 per minute of a call, with the same phone line, transcription and language model</p>
            </div>
          </div>
          <p className="dk-foot">Share of the cost of one minute of a call in our cost model, at list prices, using about 550 characters of agent speech per minute. Phone line, speech to text and language model at typical list prices.</p>
        </div>
      </section>

      <section className="dk-s dk-dark">
        <div className="dk-wrap">
          <h2>What it costs</h2>
          <div className="dk-cards dk-three">
            <div className="dk-card dk-cardd"><h3>Text to speech</h3><p className="dk-num">$0.004</p><p>per 1,000 characters for our standard voices. Our expressive voices are $0.01.</p></div>
            <div className="dk-card dk-cardd"><h3>Speech to text</h3><p className="dk-num">$0.11</p><p>per hour of audio, billed by the second, 10 second minimum per request. Batch: you send audio clips and get the transcript back.</p></div>
            <div className="dk-card dk-cardd"><h3>Try it free</h3><p className="dk-num">$0.10</p><p>of free credit, about 10,000 characters. Pay as you go, no monthly minimum.</p></div>
          </div>
        </div>
      </section>

      <section className="dk-s dk-light">
        <div className="dk-wrap">
          <h2>Speed: about 200 ms to first audio</h2>
          <div className="dk-cards">
            <div className="dk-card"><p className="dk-num dk-blue">~200 ms</p><p>from request sent to the first audio, measured from San Jose with our standard voices.</p></div>
            <div className="dk-card"><p className="dk-num dk-blue">230 to 550 ms</p><p>on spot checks of our public demo from a laptop, including the network.</p></div>
          </div>
          <p>The voice is one part of the turn. Natural turn-taking needs the whole reply, transcription, model and voice together, back in under about 2 seconds. The live number shows on the demo at <a href="https://readaloudai.org">readaloudai.org</a>.</p>
        </div>
      </section>

      <section className="dk-s dk-dark" id="hear">
        <div className="dk-wrap">
          <h2>Hear it</h2>
          <p className="dk-quote">&ldquo;Thanks for calling Bright Smile Dental, this is Sarah. How can I help you today?&rdquo;</p>
          <audio controls preload="none" src="/samples/compare/new-voice.mp3" style={{ width: '100%', maxWidth: 560 }} />
          <p>Our current default voice. Type your own text on the homepage, or send us two or three of your own lines and we return the audio.</p>
        </div>
      </section>

      <section className="dk-s dk-light">
        <div className="dk-wrap">
          <h2>Two voice tiers, so cost and expressiveness are your call</h2>
          <div className="dk-cards">
            <div className="dk-card"><h3>Standard voices</h3><p className="dk-num">$0.004</p><p>per 1,000 characters. Our lowest-cost tier. A less expressive read than the largest models. A good fit for greetings, hours, directions and confirmations.</p></div>
            <div className="dk-card"><h3>Expressive voices</h3><p className="dk-num">$0.01</p><p>per 1,000 characters. Our more expressive voices. Use them where tone matters, such as apologies and longer replies.</p></div>
          </div>
          <p>Try both on your own lines before you decide.</p>
        </div>
      </section>

      <section className="dk-s dk-dark">
        <div className="dk-wrap">
          <h2>Custom voices and languages, by arrangement</h2>
          <div className="dk-cards dk-three">
            <div className="dk-card dk-cardd"><h3>We tune to your lines</h3><p>We fine-tune voices for your use case, starting from your own scripts. Our estimate is hours to about a day per voice and language, and jobs can run in parallel. We confirm on your project.</p></div>
            <div className="dk-card dk-cardd"><h3>Clean data, written down</h3><p>For a custom voice we keep a record of where the training audio comes from and what licence covers it, so you can show your own customers.</p></div>
            <div className="dk-card dk-cardd"><h3>More expressive takes data</h3><p>A more expressive voice needs a better dataset. That is something we would explore together as the partnership grows.</p></div>
          </div>
        </div>
      </section>

      <section className="dk-s dk-light">
        <div className="dk-wrap">
          <h2>Next steps</h2>
          <ol className="dk-steps">
            <li>You send two or three sample lines. We return the audio, in both voice tiers.</li>
            <li>We send our hourly pricing in writing, so you can compare it with what you pay today.</li>
            <li>You try the free credits in your own stack.</li>
            <li>We agree a date for a follow-up call.</li>
          </ol>
          <p className="dk-contact">outreach@calldesk.tech &middot; 425-628-4887 &middot; <a href="https://readaloudai.org">readaloudai.org</a></p>
        </div>
      </section>
    </div>
  )
}

const CSS = `
.dk{height:100vh;overflow-y:auto;scroll-snap-type:y proximity;font-family:var(--font-body),system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.dk *{box-sizing:border-box}
.dk-s{min-height:100vh;display:flex;align-items:center;padding:8vh 6vw;scroll-snap-align:start}
.dk-dark{background:#151A23;color:#F1EFE8}
.dk-light{background:#F6F4EF;color:#1B1F27}
.dk-wrap{max-width:1120px;margin:0 auto;width:100%;display:flex;flex-direction:column;gap:28px}
.dk h1{font-size:clamp(34px,6vw,76px);line-height:1.05;font-weight:700;margin:0;font-family:var(--font-display),system-ui,sans-serif}
.dk h2{font-size:clamp(28px,4.2vw,52px);line-height:1.1;font-weight:700;margin:0;font-family:var(--font-display),system-ui,sans-serif}
.dk h3{font-size:clamp(18px,2vw,24px);line-height:1.25;font-weight:700;margin:0}
.dk p{font-size:clamp(16px,1.7vw,22px);line-height:1.45;margin:0}
.dk a{color:#2F5BEA;text-decoration:underline}
.dk-dark a{color:#7FA2FF}
.dk-eyebrow{font-size:16px!important;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#F2B233}
.dk-sub{color:#B7BCC8;font-size:clamp(18px,2.2vw,28px)!important}
.dk-hint{color:#8E95A5;font-size:16px!important}
.dk-cards{display:flex;gap:24px;flex-wrap:wrap}
.dk-card{flex:1 1 320px;background:#FCFBF8;border:1px solid #DDD9CE;border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:14px;color:#1B1F27}
.dk-cardd{background:#1F2633;border-color:#2E3748;color:#F1EFE8}
.dk-cardd h3{color:#F2B233}
.dk-three .dk-card{flex:1 1 260px}
.dk-num{font-size:clamp(34px,5vw,60px)!important;font-weight:700;line-height:1.05!important}
.dk-blue{color:#2F5BEA}
.dk-row{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.dk-donut{position:relative;width:300px;height:300px;flex:none}
.dk-donut-big{position:absolute;left:0;right:0;top:112px;text-align:center;font-size:48px!important;font-weight:700;line-height:1!important}
.dk-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;font-size:clamp(16px,1.7vw,22px)}
.dk-legend li{display:flex;align-items:center;gap:12px}
.dk-legend span{display:inline-block;width:22px;height:22px;border-radius:5px;flex:none}
.dk-cap{color:#4A5160}
.dk-foot{color:#6A7179;font-size:14px!important}
.dk-quote{font-style:italic;color:#B7BCC8}
.dk-steps{margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:14px;font-size:clamp(18px,2vw,26px);line-height:1.4}
.dk-contact{color:#4A5160;font-size:clamp(16px,1.8vw,22px)!important}
`
