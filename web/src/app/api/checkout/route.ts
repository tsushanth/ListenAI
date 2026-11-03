import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { stripe, STRIPE_PRICES } from '@/lib/stripe'
import {
  getOrCreateCheckoutSession,
  isUserInitiatedNavigation,
  parsePlan,
  type CheckoutPlan,
  type CheckoutStripeLike,
} from '@/lib/checkoutSession'
import { checkoutAccess } from '@/lib/webPro'

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
      existingSessionId: request.cookies.get(sessionCookie(plan))?.value ?? null,
    })
    const res = NextResponse.redirect(result.url, { status: 303 })
    const cookie = { httpOnly: true, secure: true, sameSite: 'lax' as const, maxAge: COOKIE_MAX_AGE, path: '/' }
    res.cookies.set(VISITOR_COOKIE, visitorId, cookie)
    res.cookies.set(sessionCookie(plan), result.sessionId, cookie)
    return res
  } catch (error) {
    console.error('Stripe checkout error:', error)
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}

// The pricing page submits a form here, so a Checkout Session exists only because a person pressed a plan button.
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null)
  const plan = parsePlan(form?.get('plan'))
  if (!plan) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  return startCheckout(request, plan)
}

// Legacy /api/checkout?plan=... links (old cached pages, bookmarks, outside links). GET must not have side
// effects: prefetchers and crawlers hit it. Only a real user-initiated browser navigation starts checkout;
// everything else is sent to the consumer pricing section (/reader), whose buttons POST.
export async function GET(request: NextRequest) {
  const plan = parsePlan(request.nextUrl.searchParams.get('plan'))
  if (!plan) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 })
  if (!isUserInitiatedNavigation(request.headers)) return backToPricing()
  return startCheckout(request, plan)
}
