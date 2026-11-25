// Production wiring for the voice-cloning feature: builds CloneDeps from env, or null when the serving app
// / ASR is not configured (feature stays dark: nothing here is enabled by merging code).
import { consentPhraseRequired, loadClonePolicy } from './policy.js';
import { serviceClientFromEnv } from './serviceClient.js';
import { asrFromEnv } from './asrClient.js';
import { supabaseCloneStore, supabaseConsentBlobs } from './supabaseStore.js';
import { getBillingForUser } from '../realtimeTtsBilling.js';
import { logger } from '../logger.js';
import { supabaseRevenueCatStore, type EntitlementRow } from '../revenuecat/store.js';
import { hasLiveSubscription } from '../revenuecat/lookup.js';
import type { CloneDeps } from './service.js';
import type { BillingPlan, Eligibility } from './types.js';

let cached: CloneDeps | null | undefined;

export function getCloneDeps(env: Record<string, string | undefined> = process.env): CloneDeps | null {
  if (env === process.env && cached !== undefined) return cached;
  const service = serviceClientFromEnv(env);
  const asr = asrFromEnv(env);
  const deps: CloneDeps | null = service && asr
    ? { store: supabaseCloneStore, blobs: supabaseConsentBlobs, service, asr, policy: loadClonePolicy(env), consentRequired: () => consentPhraseRequired(env),
        onPhraseMismatch: (info) => logger.warn({ event: 'voice_clone_phrase_mismatch', ...info }, 'consent phrase did not match') }
    : null;
  if (env === process.env) cached = deps;
  return deps;
}

/** Payment is required unless the operator sets VOICE_CLONE_REQUIRE_PAYMENT to the literal string "false". */
export function paymentRequired(env: Record<string, string | undefined> = process.env): boolean {
  return env.VOICE_CLONE_REQUIRE_PAYMENT !== 'false';
}

export function resolvePlan(
  billing: { active?: boolean; comped?: boolean } | null | undefined,
  env: Record<string, string | undefined> = process.env,
): BillingPlan | null {
  if (billing?.active) return billing.comped ? 'comped' : 'paid';
  return paymentRequired(env) ? null : 'free';
}

export interface PlanDeps {
  getBilling: (userId: string) => Promise<{ active?: boolean; comped?: boolean } | null | undefined>;
  /** The row the RevenueCat webhook keeps. */
  getEntitlement: (userId: string) => Promise<EntitlementRow | null>;
  /** Asks RevenueCat directly, for subscribers no webhook has reported yet. False when no API key is configured. */
  liveSubscription: (userId: string) => Promise<boolean>;
  now: () => number;
}
const defaultPlanDeps: PlanDeps = {
  getBilling: getBillingForUser,
  getEntitlement: (u) => supabaseRevenueCatStore.getEntitlement(u),
  liveSubscription: (u) => hasLiveSubscription(u),
  now: Date.now,
};

/**
 * A Google Play / App Store subscription: the webhook's row when it says active and unexpired, otherwise RevenueCat's
 * live answer. Either source failing counts as "no", so an outage never grants cloning.
 */
async function hasStoreSubscription(userId: string, deps: PlanDeps): Promise<boolean> {
  try {
    const ent = await deps.getEntitlement(userId);
    if (ent && ent.status === 'active' && ent.plan_id !== 'free' && ent.expires_at && Date.parse(ent.expires_at) > deps.now()) return true;
  } catch (err) {
    logger.warn({ err }, 'revenuecat entitlement read failed');
  }
  try {
    return await deps.liveSubscription(userId);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'revenuecat live lookup failed');
    return false;
  }
}

/**
 * comped (billing row) > paid > free (only when payment is switched off) > null. 'paid' = active realtimetts_billing
 * (Stripe) OR a store subscription (see above). The legacy `subscriptions` table is deliberately NOT consulted:
 * POST /api/subscription/sync lets any signed-in user write their own row.
 */
export async function planForUser(userId: string, deps: PlanDeps = defaultPlanDeps, env: Record<string, string | undefined> = process.env): Promise<BillingPlan | null> {
  const billing = await deps.getBilling(userId);
  if (billing?.active) return billing.comped ? 'comped' : 'paid';
  if (await hasStoreSubscription(userId, deps)) return 'paid';
  return resolvePlan(billing, env);
}

/**
 * Eligibility for synthesis with an existing voice. Email verification and the consent gate happened at
 * creation; per synthesis only continued payment is re-checked (cancelled plans stop working).
 */
export async function eligibilityForSynthesis(userId: string): Promise<Eligibility> {
  return { userId, emailVerified: true, plan: await planForUser(userId) };
}
