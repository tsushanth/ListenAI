'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Menu, X } from 'lucide-react'

const TOOLS = [
  { href: '/design-voice', label: 'Design a voice' },
  { href: '/convert-voice', label: 'Convert voice' },
  { href: '/transcribe', label: 'Transcribe audio' },
  { href: '/dub', label: 'Dub audio' },
  { href: '/audiobooks', label: 'Audiobooks' },
]

export default function RaHeader() {
  const [open, setOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!toolsOpen) return
    const onDown = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) setToolsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolsOpen])

  const closeAll = () => { setOpen(false); setToolsOpen(false) }

  return (
    <header className="ra-head">
      <div className="ra-wrap ra-head-in">
        <Link href="/" className="ra-logo"><i aria-hidden="true" />ReadAloud AI</Link>
        <nav className={`ra-nav${open ? ' open' : ''}`} aria-label="Main">
          <div className="ra-nav-tools" ref={toolsRef}>
            <button
              type="button"
              className="ra-nav-tools-btn"
              aria-expanded={toolsOpen}
              aria-haspopup="true"
              onClick={() => setToolsOpen(!toolsOpen)}
            >
              Tools <ChevronDown size={16} aria-hidden="true" />
            </button>
            {toolsOpen && (
              <div className="ra-nav-menu" role="menu">
                {TOOLS.map((t) => (
                  <Link key={t.href} href={t.href} role="menuitem" onClick={closeAll}>{t.label}</Link>
                ))}
              </div>
            )}
          </div>
          <Link href="/developers">Voice API</Link>
          <Link href="/#engines">Engines</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/developers#reference">Docs</Link>
          <Link href="/developers/mcp">MCP</Link>
          <Link href="/reader">Reader app</Link>
          <Link href="/developers#get-started" className="ra-btn solid" style={{ color: '#fff' }}>Get API key</Link>
        </nav>
        <button className="ra-menu-btn" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(!open)}>
          {open ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>
    </header>
  )
}
