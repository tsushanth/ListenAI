'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { isMockMode, voiceStudioApi } from '@/lib/voiceStudioApi'

// Shown on /developers only when the signed-in user has the voice studio enabled (the backend answers 404
// otherwise), so the feature stays invisible while it ships dark.
export default function VoiceStudioLink() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    const check = async () => {
      const { data } = await supabase.auth.getSession()
      if (!isMockMode() && !data.session) { if (live) setOn(false); return }
      const c = await voiceStudioApi.config()
      if (live) setOn(!!c)
    }
    check()
    const { data: sub } = supabase.auth.onAuthStateChange(() => { check() })
    return () => { live = false; sub.subscription.unsubscribe() }
  }, [])
  if (!on) return null
  return (
    <p style={{ marginTop: 12 }}>Need your own brand voice? <Link href="/voices" style={{ textDecoration: 'underline' }}>Create a custom voice from your recordings</Link>.</p>
  )
}
