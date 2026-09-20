import Link from 'next/link'

export default function RaFooter() {
  return (
    <footer className="ra-foot">
      <div className="ra-wrap ra-foot-grid">
        <div>
          <Link href="/" className="ra-logo"><i aria-hidden="true" />ReadAloud AI</Link>
          <p className="ra-small" style={{ marginTop: 12 }}>Realtime text-to-speech for voice agents and apps, and a reader for your own articles and documents.</p>
        </div>
        <div>
          <h4>Voice API</h4>
          <ul>
            <li><Link href="/developers">Overview and keys</Link></li>
            <li><Link href="/developers#reference">Reference</Link></li>
            <li><Link href="/developers/mcp">MCP server</Link></li>
            <li><Link href="/#engines">Engines and benchmarks</Link></li>
            <li><Link href="/#pricing">Pricing</Link></li>
          </ul>
        </div>
        <div>
          <h4>Reader app</h4>
          <ul>
            <li><Link href="/reader">About the reader</Link></li>
            <li><Link href="https://play.google.com/store/apps/details?id=com.listenai" target="_blank">Android app</Link></li>
            <li><Link href="/app">Web app</Link></li>
          </ul>
        </div>
        <div>
          <h4>Company</h4>
          <ul>
            <li><Link href="/privacy">Privacy</Link></li>
            <li><Link href="/terms">Terms</Link></li>
            <li><Link href="mailto:support@readaloudai.org">support@readaloudai.org</Link></li>
          </ul>
        </div>
      </div>
      <div className="ra-wrap"><p className="ra-small" style={{ marginTop: 32 }}>&copy; {new Date().getFullYear()} ReadAloud AI</p></div>
    </footer>
  )
}
