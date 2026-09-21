// API-key front door for voice cloning, mounted at /internal/voice-studio-api (NOT directly customer
// facing — reachable only from realtime-tts-gateway, which has already validated the caller's API key the
// same way it validates /tts/authorize, and forwards the request here with a shared secret plus the
// resolved identity as headers). Reuses the exact same business logic (createVoiceStudioRouter) as the
// Supabase web flow at routes/voiceStudio.ts: consent recording, intake calls, upload chunking, ownership
// rules and rate limiting are all identical, so a voice created via an API key and one created via the
// website are indistinguishable to the serving layer (see intake.py's owner_user_id / owner_key_ids).
//
// Identity: `x-gateway-uid` is the key's bound owner (gateway keys.js getOwnerForKey — a Supabase uid when
// the key was issued through the website's "create API key" flow) or, for keys with no bound owner, the
// key id itself (`x-gateway-key-id`). Either way it becomes intake's owner_user_id, so voices created by a
// bare API key are still deletable/listable by that same key later, and by the web UI too if the key is
// ever linked to a Supabase account.
//
// Feature flag: VOICE_STUDIO_API_ENABLED_KEYS is checked against the *key id* (x-gateway-key-id), not the
// resolved uid — see voiceStudioRouter.ts's featureFlagId. A key must be individually allowlisted (or "*")
// even if its owning uid is separately allowlisted for the web flow; the two flags are independent on
// purpose so turning on API access for a customer is a deliberate, separate decision from the web flag.
import { Request } from 'express';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { createIntakeClient } from '../lib/voiceIntakeClient.js';
import { createVoiceStudioRouter } from './voiceStudioRouter.js';

const log = logger.child({ module: 'voiceStudioApiKey' });

type GatewayReq = Request & { headers: Request['headers'] };

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const voiceStudioApiKeyRouter = createVoiceStudioRouter({
  // Trusts the gateway, not the raw API key (we never see it, and never store gateway key material here).
  // A missing/wrong shared secret, or missing identity headers, is treated as unauthenticated.
  authenticate: async (req: GatewayReq) => {
    const secret = config.GATEWAY_FORWARD_SECRET;
    const got = String(req.headers['x-gateway-admin-secret'] ?? '');
    if (!secret || !got || !timingSafeEqual(got, secret)) return null;
    const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
    const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
    const identity = uid || keyId;
    if (!identity || identity.length > 128) return null;
    return identity;
  },
  featureFlagId: (req: GatewayReq) => String(req.headers['x-gateway-key-id'] ?? '').trim(),
  requireConsentStatement: true,
  // BUG FOUND BY A LIVE E2E TEST (not code review): when a bare API key has no bound uid, `authenticate`
  // above resolves identity to the key id and that becomes owner_user_id — which intake.py's deploy
  // handler writes into Piper's owner.json as `user_ids`. But worker-piper-fly/server.py's registry only
  // matches `user_ids` against a session token's `uid` CLAIM, never against key_id — and a token minted
  // for a key with no bound uid has no `uid` claim at all. Result: the voice deployed successfully but
  // the very key that created it got "unknown voice" on every synthesize call. Fix: also tell the shared
  // router to pass this key id as `owner_key_ids`, which Piper DOES match against a token's key_id, so a
  // bare-key-owned voice is usable through both matching rules regardless of which claim ends up set.
  ownerKeyIdsFor: (req: GatewayReq) => {
    const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
    const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
    return uid ? undefined : (keyId ? [keyId] : undefined);
  },
  intake: createIntakeClient(config.VOICE_INTAKE_URL, config.INTAKE_SECRET),
  enabledUsers: () => config.VOICE_STUDIO_API_ENABLED_KEYS,
  maxVoicesPerUser: config.VOICE_STUDIO_API_MAX_VOICES_PER_KEY,
  maxZipBytes: config.VOICE_STUDIO_MAX_ZIP_MB * 1024 * 1024,
  // No Supabase account necessarily exists for a bare API key; nothing to backfill.
  backfillKeyOwners: async () => {},
  log,
  // Tighter than the web defaults (20/40/400 per hour): a raw API caller can script requests much faster
  // than a human clicking through a UI, and training is the expensive one to let someone hammer.
  rateLimits: { create: 5, preview: 30, parts: 400 },
});
