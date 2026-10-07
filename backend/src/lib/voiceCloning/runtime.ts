// Production wiring for the voice-cloning feature: builds CloneDeps from env, or null when the serving app
// / ASR is not configured (feature stays dark: nothing here is enabled by merging code).
import { loadClonePolicy } from './policy.js';
import { serviceClientFromEnv } from './serviceClient.js';
import { asrFromEnv } from './asrClient.js';
import { supabaseCloneStore, supabaseConsentBlobs } from './supabaseStore.js';
import { getBillingForUser } from '../realtimeTtsBilling.js';
import { supabaseRevenueCatStore, type EntitlementRow } from '../revenuecat/store.js';
import type { CloneDeps } from './service.js';
import type { BillingPlan, Eligibility } from './types.js';

let cached: CloneDeps | null | undefined;

export function getCloneDeps(env: Record<string, string | undefined> = process.env): CloneDeps | null {
  if (env === process.env && cached !== undefined) return cached;
  const service = serviceClientFromEnv(env);
  const asr = asrFromEnv(env);
  const deps: CloneDeps | null = service && asr
    ? { store: supabaseCloneStore, blobs: supabaseConsentBlobs, service, asr, policy: loadClonePolicy(env) }
    : null;
  if (env === process.env) cached = deps;
  return deps;
}

export interface PlanDeps {
  getBilling: (userId: string) => Promise<{ active?: boolean | null; comped?: boolean | null } | null>;
  getEntitlement: (userId: string) => Promise<EntitlementRow | null>;
  now: () => number;
}
const defaultPlanDeps: PlanDeps = { getBilling: getBillingForUser, getEntitlement: (u) => supabaseRevenueCatStore.getEntitlement(u), now: Date.now };

/**
 * comped (billing row) > paid > null. 'paid' = active realtimetts_billing (Stripe) OR an active, unexpired, non-free
 * RevenueCat entitlement (revenuecat_entitlements, written only by the signed-off webhook). The legacy `subscriptions`
 * table is deliberately NOT consulted: POST /api/subscription/sync lets any signed-in user write their own row.
 * A failing entitlement lookup fails closed (treated as no entitlement) so an outage never grants cloning.
 */
export async function planForUser(userId: string, deps: PlanDeps = defaultPlanDeps): Promise<BillingPlan | null> {
  const billing = await deps.getBilling(userId);
  if (billing?.active && billing.comped) return 'comped';
  if (billing?.active) return 'paid';
  try {
    const ent = await deps.getEntitlement(userId);
    if (ent && ent.status === 'active' && ent.plan_id !== 'free' && ent.expires_at && Date.parse(ent.expires_at) > deps.now()) return 'paid';
  } catch { /* fail closed */ }
  return null;
}

/**
 * Eligibility for synthesis with an existing voice. Email verification and the consent gate happened at
 * creation; per synthesis only continued payment is re-checked (cancelled plans stop working).
 */
export async function eligibilityForSynthesis(userId: string): Promise<Eligibility> {
  return { userId, emailVerified: true, plan: await planForUser(userId) };
}
