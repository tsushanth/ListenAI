import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { stripe, STRIPE_PRICES } from '@/lib/stripe'
import {
  getOrCreateCheckoutSession,
  parsePlan,
  type CheckoutPlan,
  type CheckoutStripeLike,
} from '@/lib/checkoutSession'
import { checkoutAccess } from '@/lib/webPro'
import { bearerToken, verifySupabaseUser } from '@/lib/checkoutAuth'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/supabaseConfig'

const VISITOR_COOKIE = 'ra_vid'
const sessionCookie = (plan: CheckoutPlan) => `ra_co_${plan}`
const COOKIE_MAX_AGE = 60 * 60 * 24

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://readaloudai.org').replace(/\/$/, '')
}

function backToPricing(): NextResponse {
  return NextResponse.redirect(`${appUrl()}/reader#pricing`, { status: 303 })
}

async function startCheckout(request: NextRequest, plan: CheckoutPlan): Promise<NextResponse> {
  // Web Pro is not sold until a purchase is tied to an account and an entitlement is granted (see lib/webPro.ts).
  // Refuse before any Stripe call, so cached pages, bookmarks and old links cannot create sessions either.
  if (checkoutAccess() === 'redirect_to_pricing') return backToPricing()

  // Signed-in only: the Stripe session carries the account (client_reference_id), and the backend webhook grants Pro to it.
  const token = bearerToken(request.headers)
  const verified = token
    ? await verifySupabaseUser(token, { supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY })
    : ({ status: 'invalid' } as const)
  if (verified.status === 'unavailable') return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 })
  if (verified.status !== 'ok') return NextResponse.json({ error: 'sign_in_required' }, { status: 401 })

  const priceId = STRIPE_PRICES[plan]
  if (!priceId) {
    return NextResponse.json({ error: 'Price not configured' }, { status: 500 })
  }

  const visitorId = request.cookies.get(VISITOR_COOKIE)?.value || randomUUID()
  try {
    const result = await getOrCreateCheckoutSession({
      stripe: stripe as unknown as CheckoutStripeLike,
      plan,
      priceId,
      appUrl: appUrl(),
      visitorId,
      user: verified.user,
      existingSessionId: request.cookies.get(sessionCookie(plan))?.value ?? null,
    })
    // JSON, not a redirect: the browser called this with fetch() so it could send the bearer token.
    const res = NextResponse.json({ url: result.url })
    const cookie = { httpOnly: true, secure: true, sameSite: 'lax' as const, maxAge: COOKIE_MAX_AGE, path: '/' }
    res.cookies.set(VISITOR_COOKIE, visitorId, cookie)
    res.cookies.set(sessionCookie(plan), result.sessionId, cookie)
    return res
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}

// A Checkout Session exists only because a signed-in person pressed a plan button (the button POSTs JSON with the bearer token).
export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type') ?? ''
  let raw: unknown = null
  if (contentType.includes('application/json')) raw = ((await request.json().catch(() => null)) as { plan?: unknown } | null)?.plan
  else raw = (await request.formData().catch(() => null))?.get('plan')
  const plan = parsePlan(raw)
  if (!plan) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  return startCheckout(request, plan)
}

// Legacy /api/checkout?plan=... links (old cached pages, bookmarks, outside links). GET must not have side effects
// (prefetchers and crawlers hit it), and a plain navigation carries no bearer token, so it can never start a signed-in
// checkout: it always sends the visitor to the pricing section, whose buttons sign in first.
export async function GET() {
  return backToPricing()
}
