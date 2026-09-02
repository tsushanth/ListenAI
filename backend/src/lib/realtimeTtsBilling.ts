// Per-user Stripe metered billing for the realtime-tts developer API — see
// supabase/migrations/012_add_tts_billing.sql for the realtimetts_billing
// table this reads/writes, and gateway/keys.js (in the separate realtime-tts
// repo) for what "billingEnabled" actually gates on the other end.
//
// Billing is per-USER, not per-key: one Stripe subscription per user covers
// all of that user's gateway keys. $0.05 per 1,000 characters synthesized,
// reported via a Stripe Billing Meter (event name realtimetts_characters),
// metered against Stripe price price_1UB47lKFBTQTkmztJ3XSMiev.
import Stripe from 'stripe';
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { drainGatewayUsage } from './ttsGatewayClient.js';

const billingLogger = logger.child({ module: 'realtimeTtsBilling' });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });

// Created once via the Stripe API (product prod_VBQz9uoIntSQWG, meter
// mtr_61VKS4vnYXmnQAsD441KFBTQTkmztIfY) — not re-derived at runtime.
const TTS_BILLING_PRICE_ID = 'price_1UB47lKFBTQTkmztJ3XSMiev';
const TTS_METER_EVENT_NAME = 'realtimetts_characters';
// Dedicated Customer Portal config (cancel + payment-method update, no plan
// changes since there's only one price) — the account's other portal
// configs belong to different products on the same shared Stripe account.
const TTS_BILLING_PORTAL_CONFIG_ID = 'bpc_1UB7PSKFBTQTkmztxt7ma3VG';

// Distinguishes a realtime-tts checkout from ReadAloud's own "pro" upgrade
// checkout in the shared Stripe webhook handler — both fire
// checkout.session.completed, and must not be confused with each other.
export const REALTIME_TTS_CHECKOUT_METADATA = { product: 'realtime-tts-api' } as const;

export interface RealtimeTtsBillingRow {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_subscription_item_id: string;
  active: boolean;
}

export async function getBillingForUser(userId: string): Promise<RealtimeTtsBillingRow | null> {
  const { data, error } = await supabase
    .from('realtimetts_billing')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    billingLogger.error({ error, userId }, 'Failed to look up realtime-tts billing');
    return null;
  }
  return data as RealtimeTtsBillingRow | null;
}

export async function isBillingActiveForUser(userId: string): Promise<boolean> {
  const row = await getBillingForUser(userId);
  return !!row?.active;
}

export async function createCheckoutSession(params: {
  userId: string;
  email: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: params.email,
    line_items: [{ price: TTS_BILLING_PRICE_ID }],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    metadata: { ...REALTIME_TTS_CHECKOUT_METADATA, userId: params.userId },
    subscription_data: {
      metadata: { ...REALTIME_TTS_CHECKOUT_METADATA, userId: params.userId },
    },
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

// Lets a user manage/cancel their subscription without any custom UI — the
// gap flagged after shipping checkout: there was no way to cancel. Requires
// an active realtimetts_billing row (a user with no subscription has
// nothing to manage here).
export async function createPortalSession(params: { userId: string; returnUrl?: string }): Promise<string> {
  const billing = await getBillingForUser(params.userId);
  if (!billing) {
    throw new Error('No billing record for this user — nothing to manage yet.');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    configuration: TTS_BILLING_PORTAL_CONFIG_ID,
    ...(params.returnUrl ? { return_url: params.returnUrl } : {}),
  });
  return session.url;
}

// Called from stripeWebhook.ts on checkout.session.completed, only for
// sessions carrying REALTIME_TTS_CHECKOUT_METADATA — separate from
// ReadAloud's own subscription-tier logic in the same webhook.
export async function activateBillingFromCheckout(session: Stripe.Checkout.Session): Promise<void> {
  const userId = session.metadata?.userId;
  const customerId = session.customer as string;
  const subscriptionId = session.subscription as string;
  if (!userId || !customerId || !subscriptionId) {
    billingLogger.warn({ sessionId: session.id }, 'realtime-tts checkout missing userId/customer/subscription');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items.data.find((i) => i.price.id === TTS_BILLING_PRICE_ID);
  if (!item) {
    billingLogger.error({ subscriptionId }, 'realtime-tts subscription has no matching price item');
    return;
  }

  const { error } = await supabase.from('realtimetts_billing').upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      stripe_subscription_item_id: item.id,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) {
    billingLogger.error({ error, userId }, 'Failed to upsert realtime-tts billing row');
    return;
  }

  // Enable every gateway key this user already has — a user who checks out
  // after already issuing keys shouldn't have to re-issue them.
  const { setGatewayKeyBilling } = await import('./ttsGatewayClient.js');
  const { data: existingKeys } = await supabase
    .from('realtimetts_api_keys')
    .select('gateway_key_id')
    .eq('user_id', userId)
    .is('revoked_at', null);
  for (const k of existingKeys || []) {
    await setGatewayKeyBilling(k.gateway_key_id, true);
  }

  billingLogger.info({ userId, subscriptionId }, 'realtime-tts billing activated');
}

export async function deactivateBillingForSubscription(subscriptionId: string): Promise<void> {
  const { data: row, error } = await supabase
    .from('realtimetts_billing')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscriptionId)
    .select()
    .maybeSingle();
  if (error || !row) return;

  const { setGatewayKeyBilling } = await import('./ttsGatewayClient.js');
  const { data: existingKeys } = await supabase
    .from('realtimetts_api_keys')
    .select('gateway_key_id')
    .eq('user_id', row.user_id)
    .is('revoked_at', null);
  for (const k of existingKeys || []) {
    await setGatewayKeyBilling(k.gateway_key_id, false);
  }
  billingLogger.info({ userId: row.user_id, subscriptionId }, 'realtime-tts billing deactivated');
}

// Pulls accumulated character usage off the gateway (per gateway key id) and
// reports it to Stripe as meter events against each key owner's customer.
// Best-effort: a failed Stripe report here loses that batch's usage (the
// gateway has already zeroed its own counters by the time drainGatewayUsage
// returns) — acceptable at this volume, see keys.js's drainUsage comment.
export async function reportUsageToStripe(): Promise<void> {
  const usage = await drainGatewayUsage();
  if (usage.length === 0) return;

  for (const { id: gatewayKeyId, chars } of usage) {
    try {
      const { data: keyRecord } = await supabase
        .from('realtimetts_api_keys')
        .select('user_id')
        .eq('gateway_key_id', gatewayKeyId)
        .maybeSingle();
      if (!keyRecord) {
        billingLogger.warn({ gatewayKeyId }, 'Usage reported for a gateway key with no owning user record');
        continue;
      }
      const billing = await getBillingForUser(keyRecord.user_id);
      if (!billing?.active) {
        billingLogger.warn({ userId: keyRecord.user_id, gatewayKeyId, chars }, 'Usage reported for a user with no active billing — dropping (should be unreachable, key should not have been billing-enabled)');
        continue;
      }
      await stripe.billing.meterEvents.create({
        event_name: TTS_METER_EVENT_NAME,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
          stripe_customer_id: billing.stripe_customer_id,
          value: String(chars),
        },
      });
    } catch (err) {
      billingLogger.error({ err, gatewayKeyId, chars }, 'Failed to report usage to Stripe');
    }
  }
}
