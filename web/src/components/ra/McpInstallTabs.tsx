'use client'

import { useState } from 'react'

const URL_ = 'https://readaloudai.org/mcp'
const cursorConfig = { url: URL_, headers: { Authorization: 'Bearer YOUR_API_KEY' } }
const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=readaloud&config=${typeof btoa === 'function' ? btoa(JSON.stringify(cursorConfig)) : ''}`

const TABS: { id: string; label: string; note: string; code: string; link?: { href: string; text: string } }[] = [
  {
    id: 'claude-code', label: 'Claude Code',
    note: 'Run this once in your terminal. Add --scope user to make it available in every project.',
    code: `claude mcp add --transport http readaloud ${URL_} \\\n  --header "Authorization: Bearer YOUR_API_KEY"`,
  },
  {
    id: 'cursor', label: 'Cursor',
    note: 'Use the button, then replace YOUR_API_KEY in Cursor’s MCP settings. Or paste this into ~/.cursor/mcp.json.',
    link: { href: cursorLink, text: 'Add to Cursor' },
    code: JSON.stringify({ mcpServers: { readaloud: cursorConfig } }, null, 2),
  },
  {
    id: 'vscode', label: 'VS Code',
    note: 'Save as .vscode/mcp.json (or run "MCP: Open User Configuration"). VS Code asks for the key once and keeps it out of the file.',
    code: JSON.stringify({
      servers: { readaloud: { type: 'http', url: URL_, headers: { Authorization: 'Bearer ${input:readaloud-key}' } } },
      inputs: [{ type: 'promptString', id: 'readaloud-key', description: 'ReadAloud AI API key', password: true }],
    }, null, 2),
  },
  {
    id: 'windsurf', label: 'Windsurf',
    note: 'Add to ~/.codeium/windsurf/mcp_config.json, then refresh the MCP list.',
    code: JSON.stringify({ mcpServers: { readaloud: { serverUrl: URL_, headers: { Authorization: 'Bearer YOUR_API_KEY' } } } }, null, 2),
  },
  {
    id: 'claude-desktop', label: 'Claude Desktop',
    note: 'Claude Desktop’s config file starts local programs, so use the mcp-remote bridge (needs Node). Add to claude_desktop_config.json and restart. In claude.ai, use Settings, Connectors instead (login, no key).',
    code: JSON.stringify({
      mcpServers: {
        readaloud: {
          command: 'npx',
          args: ['-y', 'mcp-remote', URL_, '--header', 'Authorization:${AUTH}'],
          env: { AUTH: 'Bearer YOUR_API_KEY' },
        },
      },
    }, null, 2),
  },
  {
    id: 'generic', label: 'Any other client',
    note: 'Any client that supports Streamable HTTP servers with custom headers works. Test it with curl:',
    code: `URL:     ${URL_}\nHeader:  Authorization: Bearer YOUR_API_KEY\n\ncurl -s ${URL_} \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
]

export default function McpInstallTabs() {
  const [tab, setTab] = useState(TABS[0].id)
  const [copied, setCopied] = useState(false)
  const cur = TABS.find((t) => t.id === tab)!
  return (
    <div>
      <div className="ra-code">
        <div className="ra-code-bar">
          <div className="ra-code-tabs" role="tablist" aria-label="Client" style={{ flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          <button className="ra-copy" onClick={() => { navigator.clipboard.writeText(cur.code); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre><code>{cur.code}</code></pre>
      </div>
      <p className="ra-small" style={{ marginTop: 12 }}>{cur.note}</p>
      {cur.link && <p style={{ marginTop: 8 }}><a className="ra-btn ghost" href={cur.link.href}>{cur.link.text}</a></p>}
    </div>
  )
}
