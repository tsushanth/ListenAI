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
import { config } from './config.js';
import { drainGatewayUsage, normalizeGatewayDrain } from './ttsGatewayClient.js';
import { recordUsageDaily, safeRecord, type UsageRecorder } from './usageDaily.js';
import { safeEvent, recordEvent, type EventRecorder } from './eventLog.js';

const billingLogger = logger.child({ module: 'realtimeTtsBilling' });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' });

// Voice clone pricing
const VOICE_CLONE_PRICE_CENTS = 250;

// Created once via the Stripe API (product prod_VBQz9uoIntSQWG, meter
// mtr_61VKS4vnYXmnQAsD441KFBTQTkmztIfY) — not re-derived at runtime.
const TTS_BILLING_PRICE_ID = 'price_1UCU4gKFBTQTkmztYE2RuWia';
const TTS_METER_EVENT_NAME = 'realtimetts_characters';
// Voice design meter (created once via Stripe Dashboard or scripts/create-voice-design-meter.mjs).
// Set these env vars after creating the meter/price.
const VOICE_DESIGN_METER_EVENT_NAME = process.env.VOICE_DESIGN_METER_EVENT_NAME || 'realtimetts_voice_design_generations';
// Sound effect meter name. No longer used for billing (sound effects bill per second of generated
// audio through the shared character meter, see AUDIO_JOB_PRICING); kept exported so existing
// imports/env overrides keep compiling.
export const SOUND_EFFECT_GENERATION_METER_EVENT_NAME = process.env.SOUND_EFFECT_GENERATION_METER_EVENT_NAME || 'realtimetts_sound_effect_generations';
// Music generation meter (created once via scripts/create-music-generation-meter.mjs).
export const MUSIC_GENERATION_METER_EVENT_NAME = 'realtimetts_music_generations';
// The meter above only reports USAGE — it bills nothing unless the customer's
// subscription actually includes a price tied to it. That price didn't exist
// until create-music-generation-meter.mjs was run for real (previously only
// written, never executed against Stripe), so this was a real $0 gap: usage
// was tracked but never charged. Set after running that script; checkout
// gracefully omits the line item if unset, matching how VOICE_DESIGN/
// VOICE_CONVERT above are also still not wired into checkout (a separate,
// pre-existing gap, not fixed here — scoped to music only).
const MUSIC_GENERATION_PRICE_ID = process.env.MUSIC_GENERATION_PRICE_ID || '';

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
// --- Per-audio-minute billing for dubbing, voice isolation, voice conversion and sound effects ---
//
// These used to send one flat meter event per job ("value: 1" on dedicated per-job meters). A flat
// fee is far below cost on long files (uploads go to 50 MB) and, because those dedicated meters were
// never attached to the checkout subscription (only TTS_BILLING_PRICE_ID is), the events billed
// nothing at all. They now bill per audio-second through the SAME character meter as TTS and STT, so
// no new Stripe objects are needed. One meter unit = one Kokoro-equivalent character = $0.00001
// ($0.01 per 1,000 characters), so a price of $P per audio-minute is P / 0.00001 units per minute.
// Same invoice trade-off as STT/Piper: the "characters" quantity is an equivalent, not raw characters.
//
// Prices (USD per audio-minute), re-derived 2026-10-02 from MEASURED Modal runs (A10G/L4/T4 at Modal's
// published per-second rates: A10 $0.000306, L4 $0.000222, T4 $0.000164; modal.com/pricing). "warm" = container
// already up; "cold-isolated" = one job on an idle app, which pays container boot + model load + the idle
// scaledown tail (60 s default; 120 s for the SFX/STT workers) that nobody else amortizes. Source of record:
// docs/MONEY_PATH_COSTS.md.
//   service   warm cost                         cold-isolated cost        price            vs EL list
//   stt       $0.0114/audio-hour (L4, measured) ~$0.03/job (15 s boot + 120 s tail)   $0.11/h   EL Scribe $0.22/h
//   dub       ~$0.0071/min (STT 0.0002 measured + translation ~0.0066 ESTIMATED from tokens + TTS 0.0003 measured)
//             cold-isolated >= $0.031 (STT part only; TTS worker cold cost not measured)   $0.15/min   EL $0.33-0.50
//   isolate   $0.0025 per 61 s job (8.1 GPU-s, A10G) $0.025/job (20 s boot + 60 s tail) $0.05/min    EL $0.12
//   convert   $0.0088/min (28.7 GPU-s per audio-min) $0.035 (30 s clip) - $0.048 (61 s clip)  $0.10/min   EL $0.12
//   sfx       $0.0019 per 12 s clip (6.3 s A10G)  $0.054/clip (56 s boot + 120 s tail)  $0.0015/s  EL $0.12/min
// Every price is >= 2.5x warm cost (smallest margin: sfx 9x, convert 11x) and below ElevenLabs. The per-minute rates
// therefore stay as they were; what changed is the MINIMUM charge, which now covers a cold-isolated job at >= 1.5x
// for dub, isolate and convert (a 10 s clip used to bring in $0.008 against ~$0.025-0.035 of cold-start cost).
// Sound effects are NOT fixed by a minimum: a cold-isolated 12 s clip costs 3x its $0.018 price, and covering that
// would take ~$0.27/min, above ElevenLabs. It is profitable only while a worker stays warm (see MONEY_PATH_COSTS.md).
// minBillableSeconds covers the fixed per-job cost (GPU cold start / model load / LLM call) that a
// very short clip would otherwise not pay for.
export type AudioJobService = 'dub' | 'isolate' | 'convert' | 'sound_effect';

/** USD value of one meter unit: the character meter's $0.01 per 1,000 characters. */
export const METER_USD_PER_UNIT = 0.00001;

export const AUDIO_JOB_PRICING: Record<AudioJobService, { unitsPerMinute: number; minBillableSeconds: number }> = {
  dub: { unitsPerMinute: 15000, minBillableSeconds: 30 }, // $0.15/min, 30 s minimum = $0.075
  isolate: { unitsPerMinute: 5000, minBillableSeconds: 45 }, // $0.05/min, 45 s minimum = $0.0375 (1.5x cold-isolated cost)
  convert: { unitsPerMinute: 10000, minBillableSeconds: 45 }, // $0.10/min, 45 s minimum = $0.075
  sound_effect: { unitsPerMinute: 9000, minBillableSeconds: 4 }, // $0.09/min = $0.0015/s
};

/**
 * Meter units to bill for one completed audio job. Duration is rounded UP to the next whole second,
 * then raised to the service's minimum; non-finite or non-positive durations fall back to the
 * minimum (a completed job is never free). Pure, for unit testing.
 */
const AUDIO_JOB_IDENTIFIER_PREFIX: Record<AudioJobService, string> = {
  dub: 'dub',
  isolate: 'voice-isolate',
  convert: 'voice-convert', // same prefix the pre-existing convert identifier used
  sound_effect: 'sound-effect',
};

export function billableAudioUnits(service: AudioJobService, audioSeconds: number | null | undefined): number {
  const { unitsPerMinute, minBillableSeconds } = AUDIO_JOB_PRICING[service];
  const secs = typeof audioSeconds === 'number' && Number.isFinite(audioSeconds) && audioSeconds > 0
    ? Math.ceil(audioSeconds - 1e-9) // -1e-9: a float like 60.0000000001 must not round up a whole second
    : 0;
  return Math.round((Math.max(secs, minBillableSeconds) * unitsPerMinute) / 60);
}

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
  // NULL for a comped row (migration 028): a comped account has no Stripe objects at all.
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  active: boolean;
  // Complimentary account: full access, never reported to or dependent on Stripe.
  comped?: boolean;
}

// --------------------------------------------------------------------------
// Free credits (per USER, one-time grant; migration 027_free_credits.sql)
// --------------------------------------------------------------------------
// Denominated in the same "character-equivalent" meter unit as everything else here (1 unit = $0.00001,
// see METER_USD_PER_UNIT), so 10,000 units = $0.10 = the "10,000 characters" the gateway's per-key free
// tier has always advertised. THE ONE PLACE to change the grant. It is passed to consume_free_credits()
// and only applies to users who have no realtimetts_free_credits row yet; already-created rows keep the
// `granted` they were created with (UPDATE that column to change existing users).
export const FREE_CREDIT_UNITS = 10000;
// Voice design has no per-unit price of its own (flat per generation, metered as '1' on a dedicated
// meter), so a free generation is charged as this flat amount ($0.05).
export const VOICE_DESIGN_FREE_CREDIT_UNITS = 5000;
export const ADD_PAYMENT_METHOD_URL = 'https://readaloudai.org/developers#get-started';

/** 402 body text for a feature that is out of free credits. Distinct from the payment-only features' message. */
export function freeCreditsExhaustedMessage(feature: string): string {
  return `Your free credits are used up. Add a payment method to keep using ${feature}: ${ADD_PAYMENT_METHOD_URL}`;
}

export interface FreeCreditsStatus {
  granted: number;
  used: number;
  remaining: number;
}

/** Free-credit balance. No row yet means an untouched full grant. A lookup error fails CLOSED (0 remaining). */
export async function getFreeCredits(userId: string): Promise<FreeCreditsStatus> {
  const { data, error } = await supabase
    .from('realtimetts_free_credits')
    .select('granted, used')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    billingLogger.error({ error, userId }, 'Failed to look up free credits (failing closed)');
    return { granted: FREE_CREDIT_UNITS, used: FREE_CREDIT_UNITS, remaining: 0 };
  }
  if (!data) return { granted: FREE_CREDIT_UNITS, used: 0, remaining: FREE_CREDIT_UNITS };
  const granted = Number(data.granted);
  const used = Number(data.used);
  return { granted, used, remaining: Math.max(0, granted - used) };
}

/**
 * Atomically deducts up to `units` from the user's free credits (SQL function consume_free_credits) and
 * returns how many were actually consumed (never more than remaining; the row is created with the default
 * grant on first use). `identifier` makes the deduction idempotent: a repeat with the same identifier
 * consumes 0. Never throws; a failure returns 0.
 */
export async function consumeFreeCredits(userId: string, units: number, identifier?: string): Promise<number> {
  if (!(units > 0)) return 0;
  try {
    const { data, error } = await supabase.rpc('consume_free_credits', {
      p_user: userId,
      p_units: Math.round(units),
      p_grant: FREE_CREDIT_UNITS,
      p_identifier: identifier ?? null,
    });
    if (error) {
      billingLogger.error({ error, userId, units }, 'consume_free_credits failed');
      return 0;
    }
    return Number(data) || 0;
  } catch (err) {
    billingLogger.error({ err, userId, units }, 'consume_free_credits threw');
    return 0;
  }
}

type ConsumeFree = (userId: string, units: number, identifier?: string) => Promise<number>;

async function deductFreeCredits(
  userId: string,
  units: number,
  what: string,
  identifier?: string,
  consume: ConsumeFree = consumeFreeCredits,
): Promise<void> {
  if (!(units > 0)) return;
  const consumed = await consume(userId, units, identifier);
  if (consumed < units) {
    // A completed job is never failed retroactively: we take what is left and log the shortfall.
    billingLogger.info({ userId, what, units, consumed }, 'Free credits fully used by this job (shortfall not charged)');
  } else {
    billingLogger.debug({ userId, what, units }, 'Free credits deducted');
  }
}

type MeterTarget =
  | { kind: 'comped' }
  | { kind: 'stripe'; billing: RealtimeTtsBillingRow & { stripe_customer_id: string } }
  | { kind: 'free' };

/** Where usage for this user is metered: nowhere (comped), Stripe (paying), or the free-credit balance. */
async function resolveMeterTarget(
  userId: string,
  getBilling: (userId: string) => Promise<RealtimeTtsBillingRow | null> = getBillingForUser,
): Promise<MeterTarget> {
  const billing = await getBilling(userId);
  if (billing?.active && billing.comped) return { kind: 'comped' };
  if (billing?.active) {
    if (billing.stripe_customer_id) return { kind: 'stripe', billing: billing as RealtimeTtsBillingRow & { stripe_customer_id: string } };
    billingLogger.warn({ userId }, 'Active non-comped billing row has no Stripe customer; metering against free credits');
  }
  return { kind: 'free' };
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

// True for a paying subscriber AND for a comped account (active=true, comped=true).
export async function isBillingActiveForUser(userId: string): Promise<boolean> {
  const row = await getBillingForUser(userId);
  return !!row?.active;
}

/** Gate for usage-metered features (dub, STT, isolate, convert, sound effects, voice design): billing active (incl. comped) OR free credits left. */
export async function hasUsageAllowance(userId: string): Promise<boolean> {
  if (await isBillingActiveForUser(userId)) return true;
  return (await getFreeCredits(userId)).remaining > 0;
}

// Pure and exported so the "does the music price get attached, and only
// when configured" decision is unit-testable without mocking the Stripe SDK.
export function buildCheckoutLineItems(): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: TTS_BILLING_PRICE_ID }];
  if (MUSIC_GENERATION_PRICE_ID) {
    lineItems.push({ price: MUSIC_GENERATION_PRICE_ID });
  }
  return lineItems;
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
    line_items: buildCheckoutLineItems(),
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
  if (!billing || !billing.stripe_customer_id) {
    throw new Error('No billing record for this user — nothing to manage yet.');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    configuration: TTS_BILLING_PORTAL_CONFIG_ID,
    ...(params.returnUrl ? { return_url: params.returnUrl } : {}),
  });
  return session.url;
}

// True when the subscription really has a way to pay: a subscription-level default payment method, the
// customer's invoice default, or any attached card. Fails CLOSED (false) if Stripe cannot be asked.
// This is what keeps "Pay-as-you-go active" honest: a subscription created outside Checkout (e.g. the
// live-mode internal smoke test) has none of these.
export async function subscriptionHasPaymentMethod(subscription: Stripe.Subscription): Promise<boolean> {
  try {
    if (subscription.default_payment_method) return true;
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) return false;
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted && customer.invoice_settings?.default_payment_method) return true;
    const cards = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    return cards.data.length > 0;
  } catch (err) {
    billingLogger.error({ err, subscriptionId: subscription.id }, 'Could not verify a payment method (treating as none)');
    return false;
  }
}

async function setUserGatewayKeysBilling(userId: string, enabled: boolean): Promise<void> {
  const { setGatewayKeyBilling } = await import('./ttsGatewayClient.js');
  const { data: existingKeys } = await supabase
    .from('realtimetts_api_keys')
    .select('gateway_key_id')
    .eq('user_id', userId)
    .is('revoked_at', null);
  for (const k of existingKeys || []) {
    await setGatewayKeyBilling(k.gateway_key_id, enabled);
  }
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
  if (subscription.metadata?.purpose === 'internal-smoke-test' || session.metadata?.purpose === 'internal-smoke-test') {
    billingLogger.warn({ subscriptionId, userId }, 'Refusing to activate realtime-tts billing for an internal smoke-test subscription');
    return;
  }
  const item = subscription.items.data.find((i) => i.price.id === TTS_BILLING_PRICE_ID);
  if (!item) {
    billingLogger.error({ subscriptionId }, 'realtime-tts subscription has no matching price item');
    return;
  }
  if (!(await subscriptionHasPaymentMethod(subscription))) {
    billingLogger.warn({ subscriptionId, userId }, 'Refusing to activate realtime-tts billing: subscription has no payment method attached');
    return;
  }

  // A comped account is never touched by Stripe events (its flag must not be overwritten by an upsert).
  const existing = await getBillingForUser(userId);
  if (existing?.comped) {
    billingLogger.info({ userId, subscriptionId }, 'User is comped; ignoring checkout activation (row left untouched)');
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
  await setUserGatewayKeysBilling(userId, true);

  billingLogger.info({ userId, subscriptionId }, 'realtime-tts billing activated');
}

export async function deactivateBillingForSubscription(subscriptionId: string): Promise<void> {
  const { data: row, error } = await supabase
    .from('realtimetts_billing')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscriptionId)
    .eq('comped', false) // Stripe events never deactivate a comped account
    .select()
    .maybeSingle();
  if (error || !row) return;

  await setUserGatewayKeysBilling(row.user_id, false);
  billingLogger.info({ userId: row.user_id, subscriptionId }, 'realtime-tts billing deactivated');
}

// Re-activates a previously deactivated row when Stripe reports the subscription active again AND a payment
// method exists. Only ever flips an existing, non-comped, inactive row matched by subscription id; creating
// billing rows stays the exclusive job of a verified Checkout completion.
export async function reactivateBillingForSubscription(subscription: Stripe.Subscription): Promise<void> {
  const { data: row, error } = await supabase
    .from('realtimetts_billing')
    .select('*')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();
  if (error || !row) return;
  const billing = row as RealtimeTtsBillingRow;
  if (billing.comped || billing.active) return;
  if (subscription.metadata?.purpose === 'internal-smoke-test') return;
  if (!(await subscriptionHasPaymentMethod(subscription))) {
    billingLogger.warn({ userId: billing.user_id, subscriptionId: subscription.id }, 'Subscription active again but has no payment method; not re-activating');
    return;
  }
  const { error: updateError } = await supabase
    .from('realtimetts_billing')
    .update({ active: true, updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id)
    .eq('comped', false);
  if (updateError) {
    billingLogger.error({ error: updateError, userId: billing.user_id }, 'Failed to re-activate realtime-tts billing');
    return;
  }
  await setUserGatewayKeysBilling(billing.user_id, true);
  billingLogger.info({ userId: billing.user_id, subscriptionId: subscription.id }, 'realtime-tts billing re-activated');
}

// customer.subscription.updated for a realtime-tts subscription. past_due (and every other status) is left
// alone on purpose: Stripe retries the payment, so that is a grace period, not a cancellation.
export async function syncBillingFromSubscription(subscription: Stripe.Subscription): Promise<void> {
  switch (subscription.status) {
    case 'canceled':
    case 'unpaid':
    case 'incomplete_expired':
      await deactivateBillingForSubscription(subscription.id);
      return;
    case 'active':
      await reactivateBillingForSubscription(subscription);
      return;
    default:
      return;
  }
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
  consumeFreeCredits: ConsumeFree;
  recordUsage?: UsageRecorder;
  recordEvent?: EventRecorder;
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
  consumeFreeCredits,
  recordUsage: recordUsageDaily,
  recordEvent,
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
  const { usage, freeChars } = normalizeGatewayDrain(await deps.drain());

  // Free-tier usage per OWNER (the gateway's shared pool across all of the user's keys). The gateway already
  // enforces the allowance, so this only keeps the credit ledger honest. Deducted whole via consumeFreeCredits
  // (capped at what remains, never charged beyond it); comped users are skipped. These chars are NOT in
  // `usage` (free keys are never in the paid entries), so nothing is counted twice.
  for (const f of freeChars) {
    try {
      if (!f?.owner || !(f.chars > 0)) continue;
      void safeRecord(deps.recordUsage, { userId: f.owner, freeChars: f.chars });
      const target = await resolveMeterTarget(f.owner, deps.getBilling);
      if (target.kind === 'comped') continue;
      await deductFreeCredits(f.owner, f.chars, 'gateway free-tier usage', undefined, deps.consumeFreeCredits);
    } catch (err) {
      billingLogger.error({ err, owner: f.owner, chars: f.chars }, 'Failed to deduct gateway free-tier usage from free credits');
    }
  }

  if (usage.length === 0) return;

  for (const entry of usage) {
    const gatewayKeyId = entry.id;
    const chars = billableChars(entry);
    let ownerId: string | undefined;
    try {
      const keyRecord = await deps.getKeyOwner(gatewayKeyId);
      if (!keyRecord) {
        billingLogger.warn({ gatewayKeyId }, 'Usage reported for a gateway key with no owning user record');
        continue;
      }
      ownerId = keyRecord.user_id;
      void safeRecord(deps.recordUsage, {
        userId: keyRecord.user_id, chars: entry.chars, piperChars: entry.piperChars, audioSeconds: entry.audioSeconds,
      });
      const target = await resolveMeterTarget(keyRecord.user_id, deps.getBilling);
      if (target.kind === 'comped') {
        billingLogger.debug({ userId: keyRecord.user_id, gatewayKeyId, chars }, 'Comped user; gateway usage not reported to Stripe');
        continue;
      }
      if (chars <= 0) continue; // e.g. a sub-0.16 s STT remainder rounds to nothing; don't send empty meter events
      if (target.kind === 'free') {
        // Paid entries for a user with no active billing (e.g. a lapsed subscription): count it against the user's credits.
        await deductFreeCredits(keyRecord.user_id, chars, 'gateway usage', undefined, deps.consumeFreeCredits);
        continue;
      }
      const billing = target.billing;
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
      void safeEvent(deps.recordEvent, { kind: 'usage_report_failed', userId: ownerId, detail: err instanceof Error ? err.message : String(err) });
    }
  }
}

// Reports one voice-design generation to Stripe as a meter event.
// Called synchronously after the Modal job succeeds, not batched.
// Best-effort: a metering failure does not fail the generation itself.
// jobId (when given) is sent as the Stripe meter event `identifier`, which Stripe dedupes on, so a job that is
// polled again after it is already done (an MCP client re-polling) is never billed twice.
export async function reportVoiceDesignUsage(userId: string, jobId?: string): Promise<void> {
  const target = await resolveMeterTarget(userId);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId }, 'Comped user; voice design usage not reported to Stripe');
    return;
  }
  if (target.kind === 'free') {
    await deductFreeCredits(userId, VOICE_DESIGN_FREE_CREDIT_UNITS, 'voice design', jobId ? `voice-design-${jobId}` : undefined);
    return;
  }
  const billing = target.billing;
  try {
    await stripe.billing.meterEvents.create({
      event_name: VOICE_DESIGN_METER_EVENT_NAME,
      ...(jobId ? { identifier: `voice-design-${jobId}` } : {}),
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: '1',
      },
    });
    billingLogger.debug({ userId }, 'Voice design usage reported');
  } catch (err) {
    billingLogger.error({ err, userId }, 'Failed to report voice design usage');
  }
}

/**
 * Reports one completed audio job (dub / isolate / convert / sound effect) to the character meter,
 * weighted by audio duration via AUDIO_JOB_PRICING. `jobId` becomes the Stripe meter event
 * `identifier`, so re-reporting the same job (e.g. a client polling a finished job) is deduplicated
 * by Stripe. Best-effort: a metering failure must never fail an already-successful job.
 */
export async function reportAudioJobUsage(
  userId: string,
  service: AudioJobService,
  audioSeconds: number | null | undefined,
  jobId?: string,
  deps: {
    getBilling: (userId: string) => Promise<RealtimeTtsBillingRow | null>;
    createMeterEvent: (params: Stripe.Billing.MeterEventCreateParams) => Promise<unknown>;
    consumeFreeCredits?: ConsumeFree;
  } = {
    getBilling: getBillingForUser,
    createMeterEvent: (params) => stripe.billing.meterEvents.create(params),
  },
): Promise<void> {
  const target = await resolveMeterTarget(userId, deps.getBilling);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId, service }, 'Comped user; audio job usage not reported to Stripe');
    return;
  }
  if (!(typeof audioSeconds === 'number' && Number.isFinite(audioSeconds) && audioSeconds > 0)) {
    billingLogger.warn({ userId, service, jobId }, 'Audio job has no usable duration; billing the minimum');
  }
  const units = billableAudioUnits(service, audioSeconds);
  if (target.kind === 'free') {
    await deductFreeCredits(userId, units, service, jobId ? `${AUDIO_JOB_IDENTIFIER_PREFIX[service]}-${jobId}` : undefined, deps.consumeFreeCredits);
    return;
  }
  const billing = target.billing;
  try {
    await deps.createMeterEvent({
      event_name: TTS_METER_EVENT_NAME,
      timestamp: Math.floor(Date.now() / 1000),
      ...(jobId ? { identifier: `${AUDIO_JOB_IDENTIFIER_PREFIX[service]}-${jobId}` } : {}),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: String(units),
      },
    });
    billingLogger.debug({ userId, service, audioSeconds, units }, 'Audio job usage reported');
  } catch (err) {
    billingLogger.error({ err, userId, service, audioSeconds, units }, 'Failed to report audio job usage');
  }
}

export const reportVoiceConvertUsage = (userId: string, sourceSeconds: number | null | undefined, jobId?: string) =>
  reportAudioJobUsage(userId, 'convert', sourceSeconds, jobId);
export const reportVoiceIsolateUsage = (userId: string, inputSeconds: number | null | undefined, jobId?: string) =>
  reportAudioJobUsage(userId, 'isolate', inputSeconds, jobId);
export const reportDubbingUsage = (userId: string, sourceSeconds: number | null | undefined, jobId?: string) =>
  reportAudioJobUsage(userId, 'dub', sourceSeconds, jobId);
export const reportSoundEffectGenerationUsage = (userId: string, durationSec: number | null | undefined, jobId?: string) =>
  reportAudioJobUsage(userId, 'sound_effect', durationSec, jobId);

// Reports one customer-facing batch speech-to-text call (backend/src/routes/stt.ts) to Stripe as a
// meter event, weighted into character-equivalents via STT_CHARS_PER_SECOND — the SAME meter/price
// as TTS characters (see the comment above STT_CHARS_PER_SECOND). This is distinct from, and in
// addition to, the gateway-key-based STT usage drain in reportUsageToStripe: that path bills whoever
// owns the *gateway* key used to call worker-stt-prod (the realtime-tts developer API product). The
// customer-facing route below authorizes against the gateway with a single shared backend-owned key
// (STT_API_KEY, same pattern as REALTIME_TTS_API_KEY in routes/realtimeTts.ts), so that gateway key's
// own usage is NOT a real end user — reportSttUsage is what actually bills the real ReadAloudAI user,
// against their own realtimetts_billing subscription. Do not let STT_API_KEY's gateway-side usage
// also reach reportUsageToStripe for a real customer, or usage would be double-billed; as long as
// STT_API_KEY is a house/backend key with no realtimetts_billing row of its own, its drained usage is
// silently dropped by reportUsageToStripe's "no owning user record" branch, which is the intended
// (if easy-to-miss) safety net here.
//
// Minimum billed duration: every successful request with audioSeconds > 0 is billed at least
// STT_MIN_BILLED_SECONDS (default 10; 0 disables). Billing only: the transcript and the returned
// `duration` are unchanged. The minimum is applied HERE and nowhere else (routes/stt.ts passes the raw
// decoded duration), so it cannot be applied twice. Zero/negative/non-finite durations stay unbilled
// (the minimum must never turn an empty-audio result into a charge), and failed requests never reach
// this function.
export function billableSttSeconds(audioSeconds: number, minSeconds: number = config.STT_MIN_BILLED_SECONDS): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 0;
  const min = Number.isFinite(minSeconds) && minSeconds > 0 ? minSeconds : 0;
  return Math.max(audioSeconds, min);
}

export async function reportSttUsage(userId: string, rawAudioSeconds: number): Promise<void> {
  const audioSeconds = billableSttSeconds(rawAudioSeconds);
  if (audioSeconds <= 0) return;
  void safeRecord(recordUsageDaily, { userId, audioSeconds: rawAudioSeconds });
  const target = await resolveMeterTarget(userId);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId }, 'Comped user; STT usage not reported to Stripe');
    return;
  }
  const chars = Math.round(audioSeconds * STT_CHARS_PER_SECOND);
  if (chars <= 0) return; // sub-0.16s remainder rounds to nothing, matches reportUsageToStripe's drain path
  if (target.kind === 'free') {
    await deductFreeCredits(userId, chars, 'stt');
    return;
  }
  const billing = target.billing;
  try {
    await stripe.billing.meterEvents.create({
      event_name: TTS_METER_EVENT_NAME,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: String(chars),
      },
    });
    billingLogger.debug({ userId, rawAudioSeconds, audioSeconds, chars }, 'STT usage reported');
  } catch (err) {
    billingLogger.error({ err, userId, audioSeconds }, 'Failed to report STT usage');
    void safeEvent(recordEvent, { kind: 'usage_report_failed', userId, detail: err instanceof Error ? err.message : String(err) });
  }
}

// --------------------------------------------------------------------------
// Voice clone one-time charge ($2.50)
// --------------------------------------------------------------------------

async function resolveUserId(identity: string): Promise<string | null> {
  // Supabase uids contain hyphens; gateway key ids are short alphanumeric hashes
  if (identity.includes('-')) return identity;

  const { data } = await supabase
    .from('realtimetts_api_keys')
    .select('user_id')
    .eq('gateway_key_id', identity)
    .maybeSingle();
  return data?.user_id ?? null;
}

/** Charge $2.50 for a voice clone. Best-effort: a billing failure does not fail the voice creation. */
export async function chargeForVoiceClone(identity: string): Promise<{ success: boolean; invoiceItemId?: string; error?: string }> {
  const userId = await resolveUserId(identity);
  if (!userId) {
    billingLogger.warn({ identity }, 'chargeForVoiceClone: could not resolve user id');
    return { success: false, error: 'User not found' };
  }

  const target = await resolveMeterTarget(userId);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId }, 'Comped user; voice clone not charged');
    return { success: true };
  }
  if (target.kind === 'free') {
    billingLogger.warn({ userId, identity }, 'chargeForVoiceClone: no active billing record');
    return { success: false, error: 'No active billing record' };
  }
  const billing = target.billing;

  try {
    const item = await stripe.invoiceItems.create({
      customer: billing.stripe_customer_id,
      amount: VOICE_CLONE_PRICE_CENTS,
      currency: 'usd',
      description: 'Voice clone training',
    });
    billingLogger.info({ userId, invoiceItemId: item.id }, 'Voice clone charge created');
    return { success: true, invoiceItemId: item.id };
  } catch (err) {
    billingLogger.error({ err, userId }, 'Failed to create voice clone charge');
    return { success: false, error: 'Stripe error' };
  }
}

// Reports one music generation to Stripe as a meter event.
// Called after a music job's status is already updated to 'ready', not before.
// Best-effort: a metering failure must not fail the (already-successful) job.
export async function reportMusicGenerationUsage(userId: string): Promise<void> {
  const target = await resolveMeterTarget(userId);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId }, 'Comped user; music usage not reported to Stripe');
    return;
  }
  if (target.kind === 'free') {
    billingLogger.warn({ userId }, 'reportMusicGenerationUsage called for user with no active billing');
    return;
  }
  const billing = target.billing;
  try {
    await stripe.billing.meterEvents.create({
      event_name: MUSIC_GENERATION_METER_EVENT_NAME,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: '1',
      },
    });
    billingLogger.debug({ userId }, 'Music generation usage reported');
  } catch (err) {
    billingLogger.error({ err, userId }, 'Failed to report music generation usage');
  }
}

// Reports TTS character usage to Stripe meter (for cloned-voice synthesis and any
// backend-served TTS). Best-effort: billing failure must not block the request.
export async function reportTtsUsage(userId: string, charCount: number): Promise<void> {
  const target = await resolveMeterTarget(userId);
  if (target.kind === 'comped') {
    billingLogger.debug({ userId }, 'Comped user; TTS usage not reported to Stripe');
    return;
  }
  if (charCount <= 0) return;
  if (target.kind === 'free') {
    await deductFreeCredits(userId, charCount, 'tts');
    return;
  }
  const billing = target.billing;
  try {
    await stripe.billing.meterEvents.create({
      event_name: TTS_METER_EVENT_NAME,
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        stripe_customer_id: billing.stripe_customer_id,
        value: String(charCount),
      },
    });
    billingLogger.debug({ userId, charCount }, 'TTS usage reported');
  } catch (err) {
    billingLogger.error({ err, userId, charCount }, 'Failed to report TTS usage');
  }
}
