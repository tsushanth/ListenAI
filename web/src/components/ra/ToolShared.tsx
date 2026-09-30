'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { ApiError } from '@/lib/toolsApiCommon'
import { priceLine, type PricedTool } from '@/lib/pricing'

/** Signed-in email (null when signed out), undefined while the session is still loading. */
export function useSessionEmail(): string | null | undefined {
  const [email, setEmail] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setEmail(data.session?.user.email ?? null)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (alive) setEmail(session?.user.email ?? null)
    })
    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])
  return email
}

/** True until the component unmounts; use to stop polling loops. */
export function useUnmountFlag(): () => boolean {
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
    }
  }, [])
  return () => gone.current
}

export interface UiError {
  message: string
  /** 402: the account has no active subscription. */
  subscription: boolean
}

export function toUiError(e: unknown, fallback: string): UiError {
  if (e instanceof ApiError) return { message: e.message, subscription: e.subscriptionRequired }
  return { message: e instanceof Error ? e.message : fallback, subscription: false }
}

export function SignInGate({ title }: { title: string }) {
  return (
    <div className="ra-vs-card" style={{ maxWidth: 460 }}>
      <h2>{title}</h2>
      <p className="ra-lede" style={{ fontSize: '1rem' }}>Use the same ReadAloud AI account as your API keys.</p>
      <a className="ra-btn solid" href="/app">Sign in</a>
    </div>
  )
}

export function LoadingCard() {
  return (
    <div className="ra-vs-card" style={{ maxWidth: 460 }} role="status" aria-live="polite">
      <p className="ra-small">Loading...</p>
    </div>
  )
}

export function ErrorNotice({ error }: { error: UiError | null }) {
  if (!error) return null
  if (error.subscription) {
    return (
      <div className="ra-vs-notice warn" role="alert">
        <b>Payment method needed.</b> {error.message}{' '}
        New accounts get free credits; once they are used up, <a href="/developers#get-started" style={{ textDecoration: 'underline' }}>add a payment method</a> to keep using this tool.
      </div>
    )
  }
  return <p className="ra-err" role="alert">{error.message}</p>
}

export function PriceNote({ tool }: { tool: PricedTool }) {
  return <p className="ra-small" style={{ marginTop: 12 }}>{priceLine(tool)}</p>
}

export function Working({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" style={{ marginTop: 16 }}>
      <div className="ra-vs-training">
        <div className="ra-vs-spin" aria-hidden="true" />
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {children && <p>{children}</p>}
        </div>
      </div>
    </div>
  )
}

/** Trigger a browser download of text content. */
export function downloadText(filename: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
