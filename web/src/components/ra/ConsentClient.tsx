'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'

export default function ConsentClient({ clientName, params, cancelUrl }: { clientName: string; params: string; cancelUrl: string }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) setError(err.message)
    setBusy(false)
  }

  const approve = async () => {
    if (!session) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/oauth/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ params }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.redirect_url) throw new Error(data.error || 'Could not approve. Try again.')
      window.location.href = data.redirect_url
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not approve. Try again.')
      setBusy(false)
    }
  }

  const field = { width: '100%', padding: '12px 14px', border: '1.5px solid var(--line)', borderRadius: 12, font: 'inherit', marginBottom: 12 } as const

  if (!ready) return <p><Loader2 size={18} className="animate-spin" aria-label="Loading" /></p>

  return (
    <>
      <h1 style={{ fontSize: '1.8rem' }}>Connect {clientName}</h1>
      {!session ? (
        <form onSubmit={signIn}>
          <p className="ra-lede" style={{ marginBottom: 20 }}>Sign in to your ReadAloud AI account to continue. <strong>{clientName}</strong> wants to use it to generate speech.</p>
          <label htmlFor="c-email">Email</label>
          <input id="c-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={field} />
          <label htmlFor="c-pw">Password</label>
          <input id="c-pw" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} style={field} />
          {error && <p className="ra-err" role="alert">{error}</p>}
          <button className="ra-btn solid" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
          <p style={{ marginTop: 16, fontSize: '.9rem' }}>No account yet? Create one on the <Link href="/developers#get-started" target="_blank" style={{ textDecoration: 'underline' }}>Voice API page</Link>, then come back to this tab.</p>
        </form>
      ) : (
        <>
          <p className="ra-lede" style={{ marginBottom: 16 }}><strong>{clientName}</strong> wants to use your ReadAloud AI account ({session.user.email}) to generate speech.</p>
          <ul>
            <li>It can turn text into speech using an API key made for it, and it can list voices and check service status.</li>
            <li>Speech it generates uses your free or paid characters.</li>
            <li>It cannot see your other data or change your account.</li>
            <li>We will create a new API key called &ldquo;MCP connector ({clientName})&rdquo;. Revoke it any time from <Link href="/developers#get-started" target="_blank" style={{ textDecoration: 'underline' }}>your developer console</Link> and the connection stops working.</li>
          </ul>
          {error && <p className="ra-err" role="alert" style={{ marginTop: 12 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
            <button className="ra-btn solid" disabled={busy} onClick={approve}>{busy ? 'Connecting…' : 'Approve'}</button>
            <button className="ra-btn ghost" disabled={busy} onClick={() => { window.location.href = cancelUrl }}>Cancel</button>
          </div>
          <p style={{ marginTop: 16, fontSize: '.9rem' }}>Not you? <button style={{ textDecoration: 'underline', background: 'none', border: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => supabase.auth.signOut()}>Sign out</button></p>
        </>
      )}
    </>
  )
}
