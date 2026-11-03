'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { useSessionEmail } from '@/components/ra/ToolShared'
import { startWebCheckout } from '@/lib/checkoutClient'
import type { CheckoutPlan } from '@/lib/checkoutSession'

// Only rendered while WEB_PRO_CHECKOUT_ENABLED is true (see lib/webPro.ts). Signed out: "Sign in to continue" (the account
// is what Pro is granted to). Signed in: POST the plan with the Supabase token and go to Stripe's hosted checkout.
export default function ProCheckoutButton({ plan, label, className }: { plan: CheckoutPlan; label: string; className: string }) {
  const email = useSessionEmail()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (email === null) {
    return (
      <a href="/app" className={`${className} block`}>
        Sign in to continue
      </a>
    )
  }

  async function go() {
    setBusy(true)
    setError(null)
    const { data } = await supabase.auth.getSession()
    const r = await startWebCheckout({ plan, token: data.session?.access_token })
    if (r.status === 'redirect') {
      window.location.assign(r.url)
      return
    }
    if (r.status === 'sign_in') {
      window.location.assign('/app')
      return
    }
    setError(r.message)
    setBusy(false)
  }

  return (
    <div>
      <button type="button" onClick={go} disabled={busy || email === undefined} className={className}>
        {busy ? 'Opening checkout...' : label}
      </button>
      {error && (
        <p role="alert" className="text-red-400 text-sm mt-2 text-center">
          {error}
        </p>
      )}
    </div>
  )
}
