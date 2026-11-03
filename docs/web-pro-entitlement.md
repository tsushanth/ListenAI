# Web Pro entitlement

Status: built, switched off. Two switches, both off by default:

| Switch | Where | Effect when off |
|---|---|---|
| `WEB_PRO_CHECKOUT_ENABLED` (code constant, `web/src/lib/webPro.ts`) | web | The web does not sell Pro. Pricing buttons link to Google Play, `/api/checkout` redirects to `/reader#pricing`, `/success` states nothing about activation. |
| `WEB_PRO_ENTITLEMENT_ENABLED` (env var, backend) | backend | `POST /api/webhooks/stripe` behaves exactly as before for non-realtime-tts events (legacy handlers). `GET /api/entitlement` still works. |

## How a web purchase becomes Pro

1. Visitor signs in (Supabase session) and presses a Pro button. The browser POSTs `{plan}` to the web `/api/checkout` with its access token.
2. The route asks Supabase who the token belongs to, then creates a Checkout Session with `client_reference_id` = user id, `customer_email`, and `metadata` (`source=readaloud_web_pricing`, `user_id`) on both the session and the subscription.
3. Stripe calls the backend `POST /api/webhooks/stripe` (signature verified). With `WEB_PRO_ENTITLEMENT_ENABLED=true`, `lib/webEntitlement.ts` handles:
   - `checkout.session.completed`: resolve the account by `client_reference_id`, then by a unique `app_users.email` match; record a Stripe row in `entitlement_sources`.
   - `customer.subscription.created|updated`: active/trialing -> pro, past_due -> pro (grace while Stripe retries), canceled/unpaid/paused/incomplete_expired -> free, incomplete -> nothing.
   - `customer.subscription.deleted`: free.
   - `invoice.payment_failed`: status past_due (still pro until Stripe ends the subscription).
   - Replay protection: one row per Stripe event id in `stripe_webhook_events`. Out-of-order protection: events older than the newest applied one are ignored. A handler error releases the claim and answers 500 so Stripe retries.
   - Events that are not ReadAloud web checkouts (the Stripe account is shared) are ignored.
4. After every change the effective tier is recomputed from all of the user's sources and written to `subscriptions.plan_id`, the one table `getUserTier()` reads. Nothing else reads `entitlement_sources`.
5. `/success` polls `GET /api/entitlement` (bearer token, strict 401 without one) and says the plan is active only when the backend reports an active Stripe source for the signed-in account.

The legacy handlers wrote `users.subscription_tier`. No migration or schema file defines a `users` table, and `getUserTier()` never read it, so they were not a source of truth. They only run when the flag is off.

## One tier per user: highest wins

`entitlement_sources` holds one row per (user, source): `stripe` now, `revenuecat` reserved for the RevenueCat webhook (`feature/revenuecat-webhook`, not merged). The effective tier is the highest tier among sources that are active (status active/trialing/past_due, and not more than 3 days past `current_period_end`). Examples:

- Android Pro (RevenueCat row) + web Pro cancelled: stays Pro.
- Web Pro active, no other source: Pro; web cancel -> Free.
- A `subscriptions` row not written by this ledger (`entitlement_managed = false`, e.g. a comped `unlimited` user) is never lowered or removed. It is only raised.

## What is NOT handled

- **Android does not read the backend entitlement.** Android Pro is `RevenueCatManager.entitlements["premium"]` only, so a web purchase does not unlock Android client features, and an Android purchase does not appear in `subscriptions` until a RevenueCat webhook writes the `revenuecat` source. Two paid subscriptions (one per store) are possible and nothing prevents or refunds the duplicate.
- **What Pro unlocks on the web is only what the backend tier gates**: quotas, per-job size, rate limits, priority and voice `tier_required` in `/api/tts`, `/api/voices`, audiobooks. Voice cloning is gated by `realtimetts_billing` (the pay-as-you-go API plan), not by tier, and PDF import, no-ads and the other items in the pricing card are not tier-driven. The Pro feature list on the pricing card describes the Android plan.
- **Refunds and chargebacks** (`charge.refunded`, `charge.dispute.*`) are not handled. Access ends only when Stripe ends the subscription.
- **No cancel/manage UI for web subscribers** (no Stripe Customer Portal link), and no payment-failed email (the legacy TODO is still a TODO).
- Switching plans (weekly <-> yearly) is "buy again": the newest purchase replaces the ledger row; the older subscription is not cancelled automatically (its end event is ignored while a newer one is current).
- A missed webhook: if `customer.subscription.deleted` never arrives, access lapses 3 days after the stored period end. If renewals are missed for longer than that, a paying user loses access until the next event.
- Email fallback matches only a unique `app_users.email`; with no match the event is answered 200, nothing is granted and an owner alert (`STRIPE_WEBHOOK_USER_UNRESOLVED`) is sent. The claim is released so the event can be re-sent from the Stripe dashboard.
- Whether the web and Android apps share one Supabase project was only checked by URL (same project ref in both), not by signing in.

## Owner steps (names only; no values here)

1. Merge the web-honesty PR first (it is the safe fallback), then this PR. Merging deploys web and backend; both are inert.
2. Supabase SQL editor: run `backend/supabase/migrations/036_web_pro_entitlement.sql` (rollback: `backend/supabase/rollbacks/036_rollback.sql`). MIGRATION-NOT-APPLIED until you do.
3. Stripe dashboard (test mode first): one webhook endpoint `https://<backend host>/api/webhooks/stripe` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed` (plus whatever the realtime-tts billing already listens to there). The backend reads one signing secret, so add the events to the existing backend endpoint rather than creating a second one. If the dashboard's ReadAloud endpoint points at the web app's `/api/webhook`, that route only logs: repoint it.
4. Backend env (Fly app `listenai-backend`): `STRIPE_WEBHOOK_SECRET` must be the signing secret of that endpoint (already used today); add `WEB_PRO_ENTITLEMENT_ENABLED=true` only after step 2.
5. Web env: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO_WEEKLY`, `STRIPE_PRICE_PRO_YEARLY` (already required), `NEXT_PUBLIC_API_URL` (defaults to the backend host), `NEXT_PUBLIC_APP_URL`.
6. Test the whole flow with Stripe test keys and a test price, then flip `WEB_PRO_CHECKOUT_ENABLED` to `true` in `web/src/lib/webPro.ts` in its own small PR.
