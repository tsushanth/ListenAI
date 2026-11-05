// Identity for the API-key front door of voice cloning (routes/voiceCloneApiKey.ts).
//
// Same trust model as routes/voiceStudioApiKey.ts and middleware/apiKeyAuth.ts: this process never sees the
// raw API key. A trusted forwarder (the realtime-tts gateway, or the readaloud-web MCP / REST layer, which
// validated the key against the gateway first) sends the shared secret in `x-gateway-admin-secret` plus the
// already-resolved identity: `x-gateway-uid` (the Supabase user the key is bound to) or, for a key with no
// bound user, `x-gateway-key-id`.
//
// Cloning is stricter than the other API-key features: a cloned voice is a biometric identifier tied to a
// person and an account (consent record, daily limit, takedown, deletion all key off the user id), so a bare
// key with no bound account cannot clone ('account_required'). The user must be a real Supabase user with a
// confirmed email and an eligible plan, exactly as for the website flow. Nothing here weakens a gate.
import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { BillingPlan, Eligibility } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiKeyIdentity =
  | { kind: 'eligibility'; eligibility: Eligibility }
  /** Secret missing/wrong, no identity header, or the bound user does not exist. */
  | { kind: 'unauthenticated' }
  /** Valid forwarder, but the key has no bound account. */
  | { kind: 'account_required' }
  /** The account/billing lookup itself failed (Supabase outage): not the caller's fault, retry later. */
  | { kind: 'unavailable' };

export interface ApiKeyIdentityDeps {
  forwardSecret: () => string | undefined;
  /** The Supabase user for a uid, or null if unknown. Throws on a lookup failure ('unavailable'). */
  getUser: (uid: string) => Promise<{ emailVerified: boolean } | null>;
  planFor: (uid: string) => Promise<BillingPlan | null>;
}

function secretsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && nodeTimingSafeEqual(x, y);
}

/** Resolves who is calling. Never throws. */
export async function resolveApiKeyIdentity(req: Request, deps: ApiKeyIdentityDeps): Promise<ApiKeyIdentity> {
  const secret = deps.forwardSecret();
  const got = String(req.headers['x-gateway-admin-secret'] ?? '');
  if (!secret || !got || !secretsEqual(got, secret)) return { kind: 'unauthenticated' };
  const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
  const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
  if (!uid && !keyId) return { kind: 'unauthenticated' };
  if (!uid || !UUID_RE.test(uid)) return { kind: 'account_required' };
  try {
    const user = await deps.getUser(uid);
    if (!user) return { kind: 'unauthenticated' };
    return { kind: 'eligibility', eligibility: { userId: uid, emailVerified: user.emailVerified, plan: await deps.planFor(uid) } };
  } catch {
    return { kind: 'unavailable' };
  }
}
