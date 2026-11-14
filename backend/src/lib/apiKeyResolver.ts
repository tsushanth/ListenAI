// Resolves a public ReadAloud API key (rtts_...) to the account that owns it, for the backend REST families
// that bill by account (dubbing, voice conversion, voice design, audio isolation, audiobooks, sound effects,
// speech-to-text compat). Used by middleware/apiKeyAuth.ts.
//
// This process never stores key material and never validates a key against a key store of its own: the
// realtime-tts gateway owns key validity, revocation and the free/billing gate (gateway/keys.js). So the key
// is checked there, then mapped to the owning account through the ownership metadata this backend already
// keeps for every console-issued key (realtimetts_api_keys, see lib/ttsApiKeys.ts):
//
//   1. POST {gateway}/dubbing/authorize {key}      -> 200 {authorized, id}   (id = the gateway's key id)
//                                                     401 invalid / revoked key
//                                                     402 free credits used up and no payment method
//   2. realtimetts_api_keys WHERE gateway_key_id = id AND revoked_at IS NULL -> user_id
//
// Both must agree: a key the gateway accepts but this backend has no live record for is NOT given an
// identity (no fallback to the key id as a pseudo-account, unlike the gateway-forwarded path), so a key that
// is not tied to an account can never be billed to a made-up account.
//
// Never logs, returns or stores the raw key: callers get ids only; the cache is keyed by a SHA-256 digest.
import { createHash } from 'node:crypto';

export const RTTS_KEY_PREFIX = 'rtts_';
/** Longest key we will even look at. Real keys are far shorter; this bounds hashing and the upstream body. */
const MAX_KEY_LENGTH = 256;

export type KeyRejection =
  | { ok: false; status: 401; code: 'invalid_api_key'; message: string }
  | { ok: false; status: 402; code: 'payment_required'; message: string }
  | { ok: false; status: 403; code: 'key_not_linked'; message: string }
  | { ok: false; status: 429; code: 'rate_limited'; message: string; retryAfterSec: number }
  | { ok: false; status: 503; code: 'key_check_unavailable'; message: string };

export type KeyResolution = { ok: true; userId: string; keyId: string } | KeyRejection;

export interface ApiKeyResolverDeps {
  /** Gateway base URL (the public client-facing host that serves /dubbing/authorize). */
  gatewayUrl: string;
  fetchImpl: typeof fetch;
  /** Owning account of a gateway key id, or null when no live (unrevoked) record exists. */
  lookupOwner: (gatewayKeyId: string) => Promise<string | null>;
  now: () => number;
  /** How long a successful resolution is reused (ms). 0 disables the cache. */
  cacheTtlMs: number;
  /** Upstream call timeout (ms). */
  timeoutMs: number;
}

interface CacheEntry { userId: string; keyId: string; expires: number }

const REJECT_INVALID: KeyRejection = { ok: false, status: 401, code: 'invalid_api_key', message: 'Invalid or revoked API key.' };

export function looksLikeRtts(key: string): boolean {
  return key.startsWith(RTTS_KEY_PREFIX) && key.length > RTTS_KEY_PREFIX.length && key.length <= MAX_KEY_LENGTH && /^[A-Za-z0-9_-]+$/.test(key);
}

export function digestKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function createApiKeyResolver(deps: ApiKeyResolverDeps) {
  const cache = new Map<string, CacheEntry>();

  function prune(t: number): void {
    for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
    // Hard cap so a flood of distinct valid keys cannot grow the map without bound.
    while (cache.size > 5000) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  async function resolve(key: string): Promise<KeyResolution> {
    if (!looksLikeRtts(key)) return REJECT_INVALID;
    const digest = digestKey(key);
    const t = deps.now();
    const hit = cache.get(digest);
    if (hit && hit.expires > t) return { ok: true, userId: hit.userId, keyId: hit.keyId };
    if (hit) cache.delete(digest);

    let res: Response;
    try {
      res = await deps.fetchImpl(`${deps.gatewayUrl.replace(/\/+$/, '')}/dubbing/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch {
      return { ok: false, status: 503, code: 'key_check_unavailable', message: 'Could not verify the API key right now. Try again shortly.' };
    }
    if (res.status === 401) return REJECT_INVALID;
    if (res.status === 402) {
      return { ok: false, status: 402, code: 'payment_required', message: 'This key has used up its free credits. Add a payment method in the developer console, then try again.' };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return { ok: false, status: 429, code: 'rate_limited', message: 'The API is rate limiting this key. Wait a moment and retry.', retryAfterSec: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : 5 };
    }
    if (!res.ok) {
      return { ok: false, status: 503, code: 'key_check_unavailable', message: 'Could not verify the API key right now. Try again shortly.' };
    }
    const body = (await res.json().catch(() => null)) as { authorized?: unknown; id?: unknown } | null;
    const keyId = typeof body?.id === 'string' ? body.id : '';
    if (body?.authorized !== true || !keyId || keyId.length > 128) {
      return { ok: false, status: 503, code: 'key_check_unavailable', message: 'Could not verify the API key right now. Try again shortly.' };
    }

    let userId: string | null;
    try {
      userId = await deps.lookupOwner(keyId);
    } catch {
      return { ok: false, status: 503, code: 'key_check_unavailable', message: 'Could not verify the API key right now. Try again shortly.' };
    }
    if (!userId) {
      // Gateway accepts it, but no live account record exists (revoked in the console, or a key never tied to an account).
      return { ok: false, status: 403, code: 'key_not_linked', message: 'This API key is not linked to an account. Create a key in the developer console.' };
    }
    if (deps.cacheTtlMs > 0) {
      cache.set(digest, { userId, keyId, expires: t + deps.cacheTtlMs });
      if (cache.size > 5000) prune(t);
    }
    return { ok: true, userId, keyId };
  }

  return { resolve, clearCache: () => cache.clear() };
}

/** Default owner lookup against the realtimetts_api_keys ownership table (lazy import keeps this module light). */
export async function lookupOwnerFromDb(gatewayKeyId: string): Promise<string | null> {
  const { supabase } = await import('./supabaseClient.js');
  const { data, error } = await supabase
    .from('realtimetts_api_keys')
    .select('user_id')
    .eq('gateway_key_id', gatewayKeyId)
    .is('revoked_at', null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { user_id?: string } | null)?.user_id ?? null;
}
