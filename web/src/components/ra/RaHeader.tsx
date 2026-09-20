'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'

export default function RaHeader() {
  const [open, setOpen] = useState(false)
  return (
    <header className="ra-head">
      <div className="ra-wrap ra-head-in">
        <Link href="/" className="ra-logo"><i aria-hidden="true" />ReadAloud AI</Link>
        <nav className={`ra-nav${open ? ' open' : ''}`} aria-label="Main">
          <Link href="/developers">Voice API</Link>
          <Link href="/#engines">Engines</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/developers#reference">Docs</Link>
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
