'use client'

import { useEffect } from 'react'

const ENDPOINT = 'https://app-failure-reporter.t-sushanth.workers.dev/v1/report'
const KEY = 'afr_9adcdf8324b13e8e5cd9cd1eb178b55c'
const MAX_PER_PAGE_LOAD = 10

// Noise that is not an app failure: cross-origin opaque errors, browser quirks, offline users, extensions.
const IGNORE = [/^Script error\.?$/i, /ResizeObserver loop/i, /Failed to fetch/i, /Load failed/i, /NetworkError/i, /AbortError/i, /chrome-extension:|moz-extension:|safari-extension:/i]

let sent = 0

export function reportWebFailure(flow: string, err: unknown, extra: Record<string, string> = {}) {
  try {
    if (sent >= MAX_PER_PAGE_LOAD || typeof window === 'undefined') return
    if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'non-error rejection')
    const text = `${e.message}\n${e.stack ?? ''}`
    if (IGNORE.some((re) => re.test(text))) return
    sent++
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Key': KEY },
      body: JSON.stringify({
        kind: 'failure',
        platform: 'web',
        version: 'web',
        flow,
        message: e.message || e.name,
        stack: e.stack ?? '',
        context: { path: window.location.pathname, ...extra },
      }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* reporting must never throw */
  }
}

/** Mount once in the root layout. Catches uncaught errors and unhandled promise rejections. */
export default function WebFailureReporter() {
  useEffect(() => {
    const onError = (ev: ErrorEvent) => reportWebFailure('window.onerror', ev.error ?? ev.message)
    const onRejection = (ev: PromiseRejectionEvent) => reportWebFailure('unhandledrejection', ev.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
  return null
}
