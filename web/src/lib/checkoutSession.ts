// Web Pro checkout: when a Stripe Checkout Session may be created, and when a still-open one is reused.
//
// Why this exists: the pricing page used to link to GET /api/checkout?plan=... and that GET created a
// Stripe Checkout Session on every hit. A Next.js <Link> prefetches in the background as soon as it
// scrolls into view (and crawlers follow links), so sessions were minted by page views, not by people
// choosing a plan: ~94 sessions in 6 weeks, none ever completed, mostly created as same-second pairs
// (one per plan link). Sessions are now created only by an explicit POST (a form button), and a
// visitor who already has a still-open session for the plan is sent back to it.

export type CheckoutPlan = 'pro_weekly' | 'pro_yearly'

export function parsePlan(value: unknown): CheckoutPlan | null {
  return value === 'pro_weekly' || value === 'pro_yearly' ? value : null
}

type HeaderBag = { get(name: string): string | null }

/** True for Next.js router prefetches / RSC fetches and browser speculative prefetches: never a person choosing a plan. */
export function isPrefetchRequest(headers: HeaderBag): boolean {
  if (headers.get('rsc') !== null) return true
  if (headers.get('next-router-prefetch') !== null) return true
  const purpose = `${headers.get('purpose') ?? ''} ${headers.get('sec-purpose') ?? ''} ${headers.get('x-purpose') ?? ''}`.toLowerCase()
  return purpose.includes('prefetch') || purpose.includes('preview')
}

/**
 * A deliberate link click in a real browser: top-level navigation triggered by the user. Crawlers, link
 * unfurlers and fetch()-based prefetchers do not send Sec-Fetch-User. Used only for the legacy GET links.
 */
export function isUserInitiatedNavigation(headers: HeaderBag): boolean {
  if (isPrefetchRequest(headers)) return false
  return headers.get('sec-fetch-user') === '?1' && headers.get('sec-fetch-mode') === 'navigate'
}

/** The slice of the Stripe SDK this module uses, so tests can pass a fake. */
export interface CheckoutStripeLike {
  checkout: {
    sessions: {
      retrieve(id: string): Promise<{ id: string; url?: string | null; status?: string | null; expires_at?: number; metadata?: Record<string, string> | null }>
      create(
        params: Record<string, unknown>,
        options?: { idempotencyKey?: string },
      ): Promise<{ id: string; url?: string | null }>
    }
  }
}

// Reuse an open session only if it still has this long to live, so a visitor is never sent to a page that expires under them.
export const MIN_REMAINING_SECONDS = 30 * 60
// Double-clicks / retries inside this window collapse into one Stripe session even without a cookie.
export const IDEMPOTENCY_WINDOW_SECONDS = 5 * 60

/** The signed-in account a checkout is for. Tying the session to it is what lets the backend grant Pro to the right user. */
export interface CheckoutUser {
  id: string
  email: string | null
}

export const CHECKOUT_SOURCE = 'readaloud_web_pricing'

export interface GetOrCreateParams {
  stripe: CheckoutStripeLike
  plan: CheckoutPlan
  priceId: string
  appUrl: string
  /** Random per-browser id from a cookie; scopes reuse and the idempotency key to one visitor. */
  visitorId: string
  /** Session id remembered in this visitor's cookie for this plan, if any. */
  existingSessionId?: string | null
  /** Signed-in account. Required by the live route; optional here so the legacy anonymous tests keep their meaning. */
  user?: CheckoutUser
  nowSeconds?: number
}

export interface CheckoutResult {
  url: string
  sessionId: string
  reused: boolean
}

export async function getOrCreateCheckoutSession(p: GetOrCreateParams): Promise<CheckoutResult> {
  const now = p.nowSeconds ?? Math.floor(Date.now() / 1000)

  if (p.existingSessionId && /^cs_[A-Za-z0-9_]+$/.test(p.existingSessionId)) {
    try {
      const s = await p.stripe.checkout.sessions.retrieve(p.existingSessionId)
      const sameVisitorAndPlan =
        s.metadata?.visitor === p.visitorId && s.metadata?.plan === p.plan && (!p.user || s.metadata?.user_id === p.user.id)
      if (sameVisitorAndPlan && s.status === 'open' && s.url && (s.expires_at ?? 0) - now >= MIN_REMAINING_SECONDS) {
        return { url: s.url, sessionId: s.id, reused: true }
      }
    } catch {
      // Unknown / unreadable session: fall through and create a fresh one.
    }
  }

  // What the customer is charged is unchanged: same price, 7-day trial, card required, promo codes allowed.
  const session = await p.stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: p.priceId, quantity: 1 }],
      success_url: `${p.appUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${p.appUrl}/reader#pricing`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      // The subscription carries the same tags: customer.subscription.* webhooks include only the subscription object.
      subscription_data: p.user
        ? { trial_period_days: 7, metadata: { source: CHECKOUT_SOURCE, plan: p.plan, user_id: p.user.id } }
        : { trial_period_days: 7 },
      // Lets us tell ReadAloud web sessions apart in the shared Stripe account, and match a reused session to its visitor.
      metadata: { source: CHECKOUT_SOURCE, plan: p.plan, visitor: p.visitorId, ...(p.user ? { user_id: p.user.id } : {}) },
      // What the backend webhook resolves the account from (client_reference_id first, then the email).
      ...(p.user ? { client_reference_id: p.user.id, ...(p.user.email ? { customer_email: p.user.email } : {}) } : {}),
    },
    { idempotencyKey: `ra-web-checkout:${p.user?.id ?? p.visitorId}:${p.plan}:${Math.floor(now / IDEMPOTENCY_WINDOW_SECONDS)}` },
  )
  if (!session.url) throw new Error('Stripe did not return a checkout URL')
  return { url: session.url, sessionId: session.id, reused: false }
}
