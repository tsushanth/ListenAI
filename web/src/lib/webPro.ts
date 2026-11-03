// Web Pro purchase switch.
//
// Why this exists: the web checkout used to sell Pro (Stripe, from the pricing section) while nothing on the web
// or the backend granted or read an entitlement from that payment: the checkout was anonymous (no user id, no
// email passed to Stripe), the web webhook only logged, and /success said "active" without checking anything.
// Until a purchase is tied to a signed-in account AND an entitlement is written and readable, the web must not
// sell Pro. Pro is sold in the Android app (Google Play, via RevenueCat), which does grant it.
//
// DO NOT flip this to true on its own. It needs, at the same time: sign-in before checkout, client_reference_id
// on the Checkout Session, a backend webhook that writes the entitlement, GET /api/entitlement for /success,
// and the Stripe webhook endpoint pointed at the backend. See the entitlement PR (WEB_PRO_ENTITLEMENT_ENABLED).

export const WEB_PRO_CHECKOUT_ENABLED = false

// Same applicationId as android/app/build.gradle.kts (guarded by test/web-pro.test.ts).
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.listenai'

export const SUPPORT_EMAIL = 'support@readaloudai.org'

export type ProPlan = 'pro_weekly' | 'pro_yearly'

export type ProCta =
  | { kind: 'android'; label: string; href: string }
  | { kind: 'checkout'; plan: ProPlan; label: string }

/** What a Pro plan button does: send the visitor to Google Play while web checkout is off, else start checkout. */
export function proCta(plan: ProPlan, enabled: boolean = WEB_PRO_CHECKOUT_ENABLED): ProCta {
  if (!enabled) return { kind: 'android', label: 'Get Pro in the Android app', href: PLAY_STORE_URL }
  return { kind: 'checkout', plan, label: 'Start Free Trial' }
}

/**
 * Server-side gate for POST/GET /api/checkout. The buttons are not enough: cached pages, bookmarks and old links
 * still post to the route, so the route itself refuses to create a Stripe session while the switch is off.
 */
export function checkoutAccess(enabled: boolean = WEB_PRO_CHECKOUT_ENABLED): 'allowed' | 'redirect_to_pricing' {
  return enabled ? 'allowed' : 'redirect_to_pricing'
}

export interface SuccessCopy {
  title: string
  body: string
  showPlayLink: boolean
}

/**
 * Copy for /success. It must never say Pro is active: this page has no verified entitlement to base that on.
 * (The entitlement PR replaces the enabled branch with a poll of GET /api/entitlement.)
 */
export function successCopy(enabled: boolean = WEB_PRO_CHECKOUT_ENABLED): SuccessCopy {
  if (!enabled) {
    return {
      title: 'Pro is available in the Android app',
      body:
        `Web checkout is not open, so nothing on this page has switched on a plan. Get Pro in the ReadAloud AI Android app (billing runs through Google Play). ` +
        `If you were charged on the web and are not sure what you received, email ${SUPPORT_EMAIL} with the email you paid with and we will sort it out.`,
      showPlayLink: true,
    }
  }
  return {
    title: 'Thanks, we are confirming your payment',
    body: `We have not confirmed your plan yet. If it does not show up shortly, email ${SUPPORT_EMAIL}.`,
    showPlayLink: true,
  }
}
