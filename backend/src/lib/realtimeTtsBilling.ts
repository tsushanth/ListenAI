// Per-user Stripe metered billing for the realtime-tts developer API — see
// supabase/migrations/012_add_tts_billing.sql for the realtimetts_billing
// table this reads/writes, and gateway/keys.js (in the separate realtime-tts
// repo) for what "billingEnabled" actually gates on the other end.
//
// Billing is per-USER, not per-key: one Stripe subscription per user covers
// all of that user's gateway keys. $0.01 per 1,000 characters synthesized
// (deliberately undercutting ElevenLabs' ~$0.05/1k floor rate — verified against
// real measured compute cost to still leave healthy margin, see realtime-tts repo's
// DECISIONS.md for the underlying cost/latency analysis), reported via a Stripe
// Billing Meter (event name realtimetts_characters), metered against Stripe price
// price_1UCU4gKFBTQTkmztYE2RuWia. (Was price_1UB47lKFBTQTkmztJ3XSMiev at $0.05/1k —
// deactivated 2026-09-05, had zero real subscribers, safe to retire outright.)
import Stripe from 'stripe';
import { supabase } from './supabaseClient.js';
import { logger } from './logger.js';
import { drainGatewayUsage } from './ttsGatewayClient.js';

const billingLogger = logger.child({ module: 'realtimeTtsBilling' });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });

// Created once via the Stripe API (product prod_VBQz9uoIntSQWG, meter
// mtr_61VKS4vnYXmnQAsD441KFBTQTkmztIfY) — not re-derived at runtime.
const TTS_BILLING_PRICE_ID = 'price_1UCU4gKFBTQTkmztYE2RuWia';
const TTS_METER_EVENT_NAME = 'realtimetts_characters';
// Piper (CPU engine) is priced at $0.004/1k chars vs Kokoro's $0.01/1k. Rather than
// add a second Stripe price/meter and migrate every live subscription, Piper chars are
// reported to the existing meter pre-weighted: 1 Piper char = 0.4 billed chars. Trade-off:
// the invoice's "characters" quantity is Kokoro-equivalent, not raw characters — move to a
// dedicated Stripe price if invoice transparency matters.
const PIPER_PRICE_RATIO = 0.4;
// Batch speech-to-text (worker-stt-prod) is metered in audio seconds and billed through the SAME character
// meter, no new Stripe objects: $0.11 per audio hour at the meter's $0.01 per 1,000 chars
//   $0.11/h / ($0.01 / 1000 chars) = 11,000 char-equivalents per hour = 11,000 / 3,600 = 3.0556 per second.
// Keep in sync with STT_CHARS_PER_SECOND in realtime-tts/gateway/keys.js (free-tier conversion).
// Same trade-off as Piper: the invoice's "characters" quantity is an equivalent, not raw characters.
export const STT_CHARS_PER_SECOND = 3.0556;
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
// Everything reportUsageToStripe touches outside this file, injectable for unit tests.
export interface UsageReportDeps {
  drain: typeof drainGatewayUsage;
  getKeyOwner: (gatewayKeyId: string) => Promise<{ user_id: string } | null>;
  getBilling: (userId: string) => Promise<RealtimeTtsBillingRow | null>;
  createMeterEvent: (params: Stripe.Billing.MeterEventCreateParams) => Promise<unknown>;
}

const defaultUsageDeps: UsageReportDeps = {
  drain: drainGatewayUsage,
  getKeyOwner: async (gatewayKeyId) => {
    const { data } = await supabase
      .from('realtimetts_api_keys')
      .select('user_id')
      .eq('gateway_key_id', gatewayKeyId)
      .maybeSingle();
    return data as { user_id: string } | null;
  },
  getBilling: getBillingForUser,
  createMeterEvent: (params) => stripe.billing.meterEvents.create(params),
};

// Billed value for one drained gateway entry, in Kokoro-equivalent characters:
// Kokoro chars at 1.0, Piper chars at PIPER_PRICE_RATIO, STT audio seconds at STT_CHARS_PER_SECOND.
export function billableChars(u: { chars: number; piperChars?: number; audioSeconds?: number }): number {
  const { chars, piperChars = 0, audioSeconds = 0 } = u;
  // `chars` from the gateway is the total across engines; piperChars is the cheaper subset.
  return Math.round((chars - piperChars) + piperChars * PIPER_PRICE_RATIO) + Math.round(audioSeconds * STT_CHARS_PER_SECOND);
}

// Pulls accumulated usage (characters, Piper characters, STT audio seconds) off the gateway (per gateway
// key id) and reports it to Stripe as meter events against each key owner's customer.
// Best-effort: a failed Stripe report here loses that batch's usage (the
// gateway has already zeroed its own counters by the time drainGatewayUsage
// returns) — acceptable at this volume, see keys.js's drainUsage comment.
export async function reportUsageToStripe(deps: UsageReportDeps = defaultUsageDeps): Promise<void> {
  const usage = await deps.drain();
  if (usage.length === 0) return;

  for (const entry of usage) {
    const gatewayKeyId = entry.id;
    const chars = billableChars(entry);
    try {
      const keyRecord = await deps.getKeyOwner(gatewayKeyId);
      if (!keyRecord) {
        billingLogger.warn({ gatewayKeyId }, 'Usage reported for a gateway key with no owning user record');
        continue;
      }
      const billing = await deps.getBilling(keyRecord.user_id);
      if (!billing?.active) {
        billingLogger.warn({ userId: keyRecord.user_id, gatewayKeyId, chars }, 'Usage reported for a user with no active billing — dropping (should be unreachable, key should not have been billing-enabled)');
        continue;
      }
      if (chars <= 0) continue; // e.g. a sub-0.16 s STT remainder rounds to nothing; don't send empty meter events
      await deps.createMeterEvent({
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
