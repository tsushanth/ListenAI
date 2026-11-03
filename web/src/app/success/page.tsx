'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CheckCircle, Info, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { supabase } from '@/lib/supabaseClient'
import { API_BASE_URL } from '@/lib/toolsApiCommon'
import { waitForEntitlement } from '@/lib/entitlementApi'
import { PLAY_STORE_URL, WEB_PRO_CHECKOUT_ENABLED, entitlementCopy, successCopy, type EntitlementState } from '@/lib/webPro'

// Never says the plan is active unless the backend (GET /api/entitlement) reports an active Stripe entitlement for the
// signed-in account. With web checkout off there is nothing to verify, so it only shows the static honest copy.
const POLL_ATTEMPTS = 20
const POLL_INTERVAL_MS = 3000

function Shell({ icon, title, body, showPlayLink }: { icon: React.ReactNode; title: string; body: string; showPlayLink: boolean }) {
  return (
    <main className="min-h-screen bg-dark flex items-center justify-center px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="max-w-md w-full text-center"
      >
        <div className="w-20 h-20 bg-primary/20 rounded-full flex items-center justify-center mx-auto mb-6">{icon}</div>
        <h1 className="text-3xl font-bold text-white mb-4">{title}</h1>
        <p className="text-gray-400 mb-8">{body}</p>

        {showPlayLink && (
          <div className="space-y-4 mb-8">
            <Link
              href={PLAY_STORE_URL}
              target="_blank"
              className="flex items-center justify-center space-x-3 bg-white text-dark px-6 py-3 rounded-xl hover:bg-gray-100 transition-colors w-full"
            >
              <span className="font-semibold">Get ReadAloud AI on Google Play</span>
            </Link>
          </div>
        )}

        <Link href="/" className="inline-flex items-center space-x-2 text-primary hover:text-primary-dark transition-colors">
          <span>Back to home</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
      </motion.div>
    </main>
  )
}

function VerifiedSuccess() {
  const [state, setState] = useState<EntitlementState>('checking')

  useEffect(() => {
    let cancelled = false
    waitForEntitlement({
      apiUrl: API_BASE_URL,
      getToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
      attempts: POLL_ATTEMPTS,
      intervalMs: POLL_INTERVAL_MS,
      isCancelled: () => cancelled,
    }).then((outcome) => {
      if (!cancelled && outcome !== 'cancelled') setState(outcome)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = entitlementCopy(state)
  const icon =
    state === 'active' ? <CheckCircle className="w-10 h-10 text-green-500" /> : state === 'checking' ? <Loader2 className="w-10 h-10 text-primary animate-spin" /> : <Info className="w-10 h-10 text-primary" />
  return <Shell icon={icon} title={copy.title} body={copy.body} showPlayLink={copy.showPlayLink} />
}

export default function SuccessPage() {
  if (WEB_PRO_CHECKOUT_ENABLED) return <VerifiedSuccess />
  const copy = successCopy(false)
  return <Shell icon={<Info className="w-10 h-10 text-primary" />} title={copy.title} body={copy.body} showPlayLink={copy.showPlayLink} />
}
