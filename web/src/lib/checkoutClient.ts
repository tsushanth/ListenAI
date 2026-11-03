// Browser side of starting a web Pro checkout: POST the plan with the Supabase token, get the Stripe URL back.

import type { CheckoutPlan } from './checkoutSession'

export type StartCheckoutResult =
  | { status: 'redirect'; url: string }
  | { status: 'sign_in' }
  | { status: 'error'; message: string }

export async function startWebCheckout(opts: {
  plan: CheckoutPlan
  token: string | null | undefined
  fetchImpl?: typeof fetch
}): Promise<StartCheckoutResult> {
  const token = (opts.token ?? '').trim()
  if (!token) return { status: 'sign_in' }
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch('/api/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ plan: opts.plan }),
    })
  } catch {
    return { status: 'error', message: 'Could not reach the server. Check your connection and try again.' }
  }
  if (res.status === 401) return { status: 'sign_in' }
  const body = (await res.json().catch(() => null)) as { url?: unknown } | null
  if (!res.ok || typeof body?.url !== 'string') return { status: 'error', message: 'Could not start checkout. Please try again in a moment.' }
  // Only ever send the browser to Stripe's hosted checkout.
  let host = ''
  try { host = new URL(body.url).hostname } catch { /* fall through */ }
  if (host !== 'checkout.stripe.com') return { status: 'error', message: 'Could not start checkout. Please try again in a moment.' }
  return { status: 'redirect', url: body.url }
}
