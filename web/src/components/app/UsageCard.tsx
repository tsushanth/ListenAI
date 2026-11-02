'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { fetchUsage, type UsageResult } from '@/lib/usageApi'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://listenai-backend.fly.dev'

// Read-only card on /app: this month's character usage from GET /api/usage. Only for signed-in (Supabase) users;
// see lib/usageApi.ts for why an anonymous visitor is never sent to the API.
export default function UsageCard() {
  const [result, setResult] = useState<UsageResult | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setResult(null)
    try {
      const { data } = await supabase.auth.getSession()
      const next = await fetchUsage({ apiUrl: API_URL, token: data.session?.access_token, signal })
      if (!signal?.aborted) setResult(next)
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      setResult({ status: 'error', message: 'Usage is unavailable right now. Please try again later.' })
    }
  }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    load(ctrl.signal)
    const { data: sub } = supabase.auth.onAuthStateChange((event) => { if (event !== 'INITIAL_SESSION') load(ctrl.signal) })
    return () => {
      ctrl.abort()
      sub.subscription.unsubscribe()
    }
  }, [load])

  return (
    <div className="glass rounded-xl p-6 mb-8" aria-live="polite">
      <h2 className="text-lg font-semibold mb-3">Usage this month</h2>
      {result === null && <p className="text-white/50 text-sm" role="status">Loading...</p>}

      {result?.status === 'anonymous' && (
        <p className="text-white/60 text-sm">
          Sign in to see how much of your monthly allowance you have used.{' '}
          <Link href="/developers#get-started" className="underline">Sign in</Link>
        </p>
      )}

      {result?.status === 'unauthorized' && (
        <p className="text-white/60 text-sm">
          Your session has expired. <Link href="/developers#get-started" className="underline">Sign in again</Link> to see your usage.
        </p>
      )}

      {result?.status === 'error' && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-red-400 text-sm" role="alert">{result.message}</p>
          <button onClick={() => load()} className="text-sm underline text-white/70 hover:text-white">Try again</button>
        </div>
      )}

      {result?.status === 'ok' && (
        <div>
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-2xl font-bold text-primary">{result.usage.percent}%</span>
            <span className="text-sm text-white/60">
              {result.usage.used.toLocaleString()} of {result.usage.limit.toLocaleString()} characters
            </span>
          </div>
          <div
            className="h-2 rounded-full bg-white/10 overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={result.usage.percent}
            aria-label="Monthly character usage"
          >
            <div className={`h-full ${result.usage.percent >= 90 ? 'bg-red-400' : 'bg-primary'}`} style={{ width: `${result.usage.percent}%` }} />
          </div>
          <p className="mt-2 text-sm text-white/50">
            About {result.usage.minutesRemaining.toLocaleString()} minutes of audio left in {result.usage.month}.
          </p>
        </div>
      )}
    </div>
  )
}
