/**
 * Web Pro (Stripe) entitlement. DEPLOY-ON-MERGE (backend), inert until WEB_PRO_ENTITLEMENT_ENABLED=true.
 *
 * One tier per user, highest wins. getUserTier() reads subscriptions.plan_id, so that table stays the single thing the
 * rest of the backend reads. Each paying channel records its own state in entitlement_sources (one row per user and
 * source: 'stripe' now, 'revenuecat' when its webhook lands), and after every change the effective tier is recomputed
 * from all of a user's sources and written to subscriptions. A subscriptions row this code did not write
 * (entitlement_managed = false: a comped or hand-set user) is never lowered or removed.
 *
 * Everything here is pure logic over an EntitlementStore, so it is tested without Supabase or Stripe.
 */
import type Stripe from 'stripe';
import type { SubscriptionTier, SubscriptionStatus } from '../types/index.js';

export type EntitlementSource = 'stripe' | 'revenuecat';

/** metadata.source that web/src/lib/checkoutSession.ts puts on every ReadAloud web Checkout Session and subscription. */
export const WEB_CHECKOUT_SOURCE = 'readaloud_web_pricing';

export function webProEntitlementEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WEB_PRO_ENTITLEMENT_ENABLED === 'true';
}

export interface SourceRow {
  user_id: string;
  source: EntitlementSource;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  /** Stripe event.created (unix seconds) of the newest event applied; older events are ignored (out-of-order delivery). */
  last_event_created: number | null;
}

export interface EffectiveEntitlement {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
}

export interface EntitlementStore {
  /** Record an event id; false when it was already recorded (replay). */
  claimEvent(eventId: string, type: string): Promise<boolean>;
  releaseEvent(eventId: string): Promise<void>;
  findStripeSourceBySubscription(subscriptionId: string): Promise<SourceRow | null>;
  getSource(userId: string, source: EntitlementSource): Promise<SourceRow | null>;
  /** The single app user with this email, or null when there is none or the email is ambiguous. */
  findUserIdByEmail(email: string): Promise<string | null>;
  ensureAppUser(userId: string, email: string | null): Promise<void>;
  upsertSource(row: SourceRow): Promise<void>;
  listSources(userId: string): Promise<SourceRow[]>;
  getSubscription(userId: string): Promise<{ plan_id: SubscriptionTier; entitlement_managed: boolean } | null>;
  writeEffective(userId: string, eff: EffectiveEntitlement): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tier resolution (highest wins)
// ---------------------------------------------------------------------------------------------------------------------

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, basic: 1, pro: 2, unlimited: 3 };
export const tierRank = (t: SubscriptionTier): number => TIER_RANK[t] ?? 0;

/** past_due keeps access while the payment processor retries; it ends with canceled/unpaid, which are not counted. */
const COUNTING_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['active', 'trialing', 'past_due']);

/**
 * If a renewal webhook is missed the stored period end goes stale. Access is kept this long past it, then lapses until
 * the next event arrives. Chosen to match Stripe's webhook retry window (3 days), so a short outage never revokes a payer.
 */
export const PERIOD_END_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

export function sourceIsActive(row: SourceRow, nowMs: number): boolean {
  if (row.tier === 'free' || !COUNTING_STATUSES.has(row.status)) return false;
  if (row.current_period_end) {
    const end = Date.parse(row.current_period_end);
    if (Number.isFinite(end) && end + PERIOD_END_GRACE_MS < nowMs) return false;
  }
  return true;
}

export function resolveEffective(sources: SourceRow[], nowMs: number): EffectiveEntitlement {
  const active = sources.filter((s) => sourceIsActive(s, nowMs));
  if (active.length > 0) {
    const best = [...active].sort((a, b) => {
      const byTier = tierRank(b.tier) - tierRank(a.tier);
      if (byTier !== 0) return byTier;
      return (Date.parse(b.current_period_end ?? '') || 0) - (Date.parse(a.current_period_end ?? '') || 0);
    })[0]!;
    return {
      tier: best.tier,
      status: best.status,
      stripe_customer_id: best.stripe_customer_id,
      stripe_subscription_id: best.stripe_subscription_id,
      current_period_end: best.current_period_end,
      canceled_at: null,
    };
  }
  const stripe = sources.find((s) => s.source === 'stripe') ?? sources[0];
  return {
    tier: 'free',
    status: stripe && stripe.status === 'expired' ? 'expired' : 'canceled',
    stripe_customer_id: stripe?.stripe_customer_id ?? null,
    stripe_subscription_id: stripe?.stripe_subscription_id ?? null,
    current_period_end: stripe?.current_period_end ?? null,
    canceled_at: stripe?.canceled_at ?? null,
  };
}

export type RecomputeResult = 'written' | 'kept_existing';

/** Recompute the user's effective tier from every source and write subscriptions (the table getUserTier reads). */
export async function recomputeEffective(userId: string, store: EntitlementStore, nowMs: number): Promise<RecomputeResult> {
  const [sources, existing] = await Promise.all([store.listSources(userId), store.getSubscription(userId)]);
  const eff = resolveEffective(sources, nowMs);
  // A row this ledger did not write is someone's explicit grant (comp, legacy). Never lower or remove it.
  if (existing && !existing.entitlement_managed && tierRank(existing.plan_id) >= tierRank(eff.tier)) return 'kept_existing';
  await store.writeEffective(userId, eff);
  return 'written';
}

// ---------------------------------------------------------------------------------------------------------------------
// Stripe events
// ---------------------------------------------------------------------------------------------------------------------

export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

export type HandleOutcome =
  | { outcome: 'applied'; userId: string; recompute: RecomputeResult }
  | { outcome: 'duplicate' }
  | { outcome: 'stale'; userId: string }
  | { outcome: 'ignored'; reason: string }
  /** A web checkout was paid but no account could be matched. The caller must alert the owner. */
  | { outcome: 'unresolved'; reason: string };

export interface HandleDeps {
  store: EntitlementStore;
  nowMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : v?.id ?? null);
const iso = (unixSeconds: number | null | undefined): string | null =>
  typeof unixSeconds === 'number' && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;

/**
 * Verified Stripe event in, entitlement out. The caller has already checked the signature; this adds replay protection
 * (event id), out-of-order protection (event.created), and never touches events that are not ReadAloud web checkouts
 * (the Stripe account is shared with other products).
 */
export async function handleStripeEvent(event: Stripe.Event, deps: HandleDeps): Promise<HandleOutcome> {
  if (!HANDLED_EVENT_TYPES.has(event.type)) return { outcome: 'ignored', reason: 'unhandled event type' };
  const { store } = deps;
  const nowMs = deps.nowMs ?? Date.now();

  if (!(await store.claimEvent(event.id, event.type))) return { outcome: 'duplicate' };

  let result: HandleOutcome;
  try {
    result = await dispatch(event, store, nowMs);
  } catch (err) {
    // Release the claim so Stripe's retry of this same event is processed rather than dropped as a duplicate.
    await store.releaseEvent(event.id).catch(() => undefined);
    throw err;
  }
  // Unresolved: keep the event re-sendable from the Stripe dashboard once the account exists.
  if (result.outcome === 'unresolved') await store.releaseEvent(event.id).catch(() => undefined);
  return result;
}

async function dispatch(event: Stripe.Event, store: EntitlementStore, nowMs: number): Promise<HandleOutcome> {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(event, event.data.object as Stripe.Checkout.Session, store, nowMs);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscription(event, event.data.object as Stripe.Subscription, store, nowMs);
    case 'invoice.payment_failed':
      return onPaymentFailed(event, event.data.object as Stripe.Invoice, store, nowMs);
    default:
      return { outcome: 'ignored', reason: 'unhandled event type' };
  }
}

async function apply(
  event: Stripe.Event,
  userId: string,
  existing: SourceRow | null,
  next: Omit<SourceRow, 'user_id' | 'source' | 'last_event_created'>,
  store: EntitlementStore,
  nowMs: number,
): Promise<HandleOutcome> {
  if (existing?.last_event_created != null && existing.last_event_created > event.created) return { outcome: 'stale', userId };
  await store.upsertSource({ ...next, user_id: userId, source: 'stripe', last_event_created: event.created });
  const recompute = await recomputeEffective(userId, store, nowMs);
  return { outcome: 'applied', userId, recompute };
}

async function onCheckoutCompleted(event: Stripe.Event, s: Stripe.Checkout.Session, store: EntitlementStore, nowMs: number): Promise<HandleOutcome> {
  if (s.metadata?.source !== WEB_CHECKOUT_SOURCE) return { outcome: 'ignored', reason: 'not a ReadAloud web checkout' };
  if (s.mode !== 'subscription') return { outcome: 'ignored', reason: 'not a subscription checkout' };
  // 'unpaid' = an async payment method that has not settled; the subscription events decide when access starts.
  if (s.payment_status === 'unpaid') return { outcome: 'ignored', reason: 'payment not settled' };
  const subscriptionId = idOf(s.subscription as string | { id: string } | null);
  if (!subscriptionId) return { outcome: 'ignored', reason: 'no subscription on session' };

  const email = (s.customer_email || s.customer_details?.email || '').trim() || null;
  let userId: string | null = s.client_reference_id && UUID_RE.test(s.client_reference_id) ? s.client_reference_id : null;
  if (!userId && email) userId = await store.findUserIdByEmail(email);
  if (!userId) return { outcome: 'unresolved', reason: 'no client_reference_id and no unique account for the email' };

  await store.ensureAppUser(userId, email);
  const existing = await store.getSource(userId, 'stripe');
  return apply(event, userId, existing, {
    tier: 'pro',
    // The subscription events that follow carry the real status (trialing, active); this is the provisional one.
    status: 'active',
    stripe_customer_id: idOf(s.customer as string | { id: string } | null),
    stripe_subscription_id: subscriptionId,
    current_period_end: existing?.stripe_subscription_id === subscriptionId ? existing.current_period_end : null,
    canceled_at: null,
  }, store, nowMs);
}

function mapSubscriptionStatus(status: Stripe.Subscription.Status): { tier: SubscriptionTier; status: SubscriptionStatus } | null {
  switch (status) {
    case 'active': return { tier: 'pro', status: 'active' };
    case 'trialing': return { tier: 'pro', status: 'trialing' };
    case 'past_due': return { tier: 'pro', status: 'past_due' };
    case 'canceled':
    case 'paused': return { tier: 'free', status: 'canceled' };
    case 'unpaid':
    case 'incomplete_expired': return { tier: 'free', status: 'expired' };
    default: return null; // 'incomplete': first payment not made yet, nothing to grant or revoke
  }
}

async function onSubscription(event: Stripe.Event, sub: Stripe.Subscription, store: EntitlementStore, nowMs: number): Promise<HandleOutcome> {
  let existing = await store.findStripeSourceBySubscription(sub.id);
  let userId = existing?.user_id ?? null;
  if (!userId) {
    const meta = sub.metadata ?? {};
    if (meta.source === WEB_CHECKOUT_SOURCE && meta.user_id && UUID_RE.test(meta.user_id)) userId = meta.user_id;
  }
  if (!userId) return { outcome: 'ignored', reason: 'subscription is not a ReadAloud web subscription' };

  const mapped = event.type === 'customer.subscription.deleted'
    ? { tier: 'free' as SubscriptionTier, status: 'canceled' as SubscriptionStatus }
    : mapSubscriptionStatus(sub.status);
  if (!mapped) return { outcome: 'ignored', reason: `subscription status ${sub.status} grants nothing` };

  await store.ensureAppUser(userId, null);
  const current = existing ?? (await store.getSource(userId, 'stripe'));
  // The ledger tracks one web subscription per user (the latest purchase). An end-of-life event for an OLDER subscription
  // (e.g. the weekly plan cancelled after the user bought the yearly one) must not revoke the current one.
  if (mapped.tier === 'free' && current?.stripe_subscription_id && current.stripe_subscription_id !== sub.id && current.tier !== 'free') {
    return { outcome: 'ignored', reason: 'event is for a superseded subscription; another is current' };
  }
  existing = current;
  const periodEnd = sub.status === 'trialing' ? sub.trial_end ?? sub.current_period_end : sub.current_period_end;
  return apply(event, userId, existing, {
    ...mapped,
    stripe_customer_id: idOf(sub.customer as string | { id: string } | null),
    stripe_subscription_id: sub.id,
    current_period_end: iso(periodEnd) ?? existing?.current_period_end ?? null,
    canceled_at: mapped.tier === 'free' ? iso(sub.canceled_at ?? event.created) : null,
  }, store, nowMs);
}

async function onPaymentFailed(event: Stripe.Event, inv: Stripe.Invoice, store: EntitlementStore, nowMs: number): Promise<HandleOutcome> {
  const subscriptionId = idOf(inv.subscription as string | { id: string } | null);
  const existing = subscriptionId ? await store.findStripeSourceBySubscription(subscriptionId) : null;
  if (!existing) return { outcome: 'ignored', reason: 'invoice is not for a ReadAloud web subscription' };
  if (existing.tier === 'free') return { outcome: 'ignored', reason: 'subscription already ended' };
  // Access continues through Stripe's retry window; customer.subscription.updated/deleted ends it.
  return apply(event, existing.user_id, existing, { ...existing, status: 'past_due' }, store, nowMs);
}
