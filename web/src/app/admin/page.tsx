'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import AdminDashboard from '@/components/AdminDashboard'

// The gate is /api/admin/overview (404 unless the token is the allowlisted Google account).
// Sign-in happens on /developers, which is already on the Supabase redirect allow list;
// the session is shared across pages on this origin.
export default function AdminPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token ?? null))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setToken(s?.access_token ?? null))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (token === undefined) return null
  if (!token) {
    return (
      <p style={{ padding: 24 }}>
        Sign in with Google on <Link href="/developers" style={{ textDecoration: 'underline' }}>/developers</Link>, then come back to this page.
      </p>
    )
  }
  return (
    <AdminDashboard
      token={token}
      scopes={[{ label: 'App', value: 'app' }, { label: 'API', value: 'api' }]}
    />
  )
}
