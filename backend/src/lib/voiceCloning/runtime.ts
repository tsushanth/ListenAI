// Production wiring for the voice-cloning feature: builds CloneDeps from env, or null when the serving app
// / ASR is not configured (feature stays dark: nothing here is enabled by merging code).
import { loadClonePolicy } from './policy.js';
import { serviceClientFromEnv } from './serviceClient.js';
import { asrFromEnv } from './asrClient.js';
import { supabaseCloneStore, supabaseConsentBlobs } from './supabaseStore.js';
import { getBillingForUser } from '../realtimeTtsBilling.js';
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

export async function planForUser(userId: string): Promise<BillingPlan | null> {
  const billing = await getBillingForUser(userId);
  if (!billing?.active) return null;
  return billing.comped ? 'comped' : 'paid';
}

/**
 * Eligibility for synthesis with an existing voice. Email verification and the consent gate happened at
 * creation; per synthesis only continued payment is re-checked (cancelled plans stop working).
 */
export async function eligibilityForSynthesis(userId: string): Promise<Eligibility> {
  return { userId, emailVerified: true, plan: await planForUser(userId) };
}
