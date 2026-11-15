// Shared "real identity or bust" auth middleware for billed backend routes that must be callable from
// BOTH the signed-in web app (real Supabase JWT) AND an MCP tool authenticating with a developer/gateway
// API key (STT, Dubbing, Sound Effects, Audiobooks all hit this same gap independently — see
// MCP_AUTH_BRIDGE.md at the repo root for the full writeup and per-route migration steps).
//
// This generalizes the trusted-forwarder pattern that routes/voiceStudioApiKey.ts already proved out for
// voice cloning: trust a shared secret (GATEWAY_FORWARD_SECRET) plus an already-resolved identity header,
// never the raw API key itself (this process never sees raw key material or validates it against the
// gateway's key store — that's the gateway's job, same as it always was for /internal/voice-studio-api).
//
// Deliberately NOT built on top of middleware/auth.ts's requireAuth: that middleware falls back to a
// shared default-user UUID for any missing/invalid/dev-mode credential, which is correct for the
// device-ID-first UX most of this app uses but wrong for anything billed or MCP-reachable (see
// routes/ttsApiKeys.ts's requireRealAuth for the other place this same "no silent fallback" rule already
// applies, and its comment for why). requireAuthOrApiKey below has exactly one non-strict path (the JWT
// verify), and every other branch is an explicit 401 — there is no default/shared-user fallback anywhere
// in this file, on purpose, so a route that adopts it can never be billed against the wrong account.
import { Request, Response, NextFunction } from 'express';
import { verifyAuthTokenRemote, extractBearerToken } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import {
  RTTS_KEY_PREFIX,
  createApiKeyResolver,
  lookupOwnerFromDb,
  type ApiKeyResolverDeps,
  type KeyResolution,
} from '../lib/apiKeyResolver.js';
import type { Logger } from 'pino';

const defaultLog = logger.child({ module: 'apiKeyAuth' });

export interface AuthedRequest extends Request {
  userId?: string;
  /** Also set as `req.user.id`, mirroring middleware/auth.ts's requireAuth shape — the four routes this
   *  was built for read the resolved identity both ways (audiobooks.ts/dub.ts read `req.user.id`;
   *  soundEffects.ts/stt.ts's own inline check reads `req.userId`), so this sets both rather than making
   *  each route file adapt to one convention. */
  user?: { id: string };
  /** How this request's identity was established — routes that bill differently per path can branch on it. */
  authMethod?: 'jwt' | 'gateway-key' | 'api-key';
  /** Gateway key id of the public (rtts_) key that authenticated this request; only set when authMethod is 'api-key'. */
  apiKeyId?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolves identity from the gateway-forwarded-secret headers, exactly like voiceStudioApiKey.ts's
 * `authenticate`. Returns null (never throws) if the secret is missing/wrong or no identity header is
 * present — every caller of this treats null as "not this auth method", not as an error, so it can be
 * tried as a fallback after JWT verification fails.
 */
function resolveGatewayForwardedIdentity(req: Request): { id: string; via: 'uid' | 'key-id' } | null {
  const secret = config.GATEWAY_FORWARD_SECRET;
  const got = String(req.headers['x-gateway-admin-secret'] ?? '');
  if (!secret || !got || !timingSafeEqual(got, secret)) return null;
  const uid = String(req.headers['x-gateway-uid'] ?? '').trim();
  const keyId = String(req.headers['x-gateway-key-id'] ?? '').trim();
  if (uid && uid.length <= 128) return { id: uid, via: 'uid' };
  if (keyId && keyId.length <= 128) return { id: keyId, via: 'key-id' };
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Public API key (rtts_...) path.
//
// One key works on every REST family, like ElevenLabs. Off unless RTTS_KEY_AUTH_ENABLED is true (read per
// request, so it can be flipped without a code change); when off, an rtts_ bearer falls through to JWT
// verification and is rejected exactly as before, and xi-api-key is ignored.
//
// There are no per-family scopes because the key model has none (a gateway key is id + owner + billing flag).
// A key reaches only the routers mounted behind this middleware; key management (/api/tts-api-keys) stays
// session-only so a leaked key cannot mint or revoke keys.
// ---------------------------------------------------------------------------------------------------------

function envBool(raw: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}
function envInt(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return raw !== undefined && raw.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function apiKeyAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envBool(env.RTTS_KEY_AUTH_ENABLED);
}

/**
 * Finds a public API key on the request: `Authorization: Bearer rtts_...` or the ElevenLabs header name
 * `xi-api-key`. A present xi-api-key header is always treated as a key attempt (a wrong-shaped value is a 401,
 * never a fall-through to JWT). A bearer that is not rtts_-shaped is not a key: it is a session token.
 */
export function extractPublicApiKey(req: Request): string | null {
  const xi = req.headers['xi-api-key'];
  const xiVal = Array.isArray(xi) ? xi[0] : xi;
  const auth = String(req.headers.authorization ?? '');
  const m = /^bearer\s+(\S+)\s*$/i.exec(auth);
  if (m && m[1]!.startsWith(RTTS_KEY_PREFIX)) return m[1]!;
  if (typeof xiVal === 'string' && xiVal.trim() !== '') return xiVal.trim();
  return null;
}

/** Sliding-window counters, per process (same posture and documented limit as lib/sttLimits.ts). */
class SlidingLimiter {
  private hits = new Map<string, number[]>();
  constructor(private windowMs: number, private now: () => number) {}
  /** Records a hit; returns retry-after seconds when over `max`, else 0. */
  hit(key: string, max: number): number {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return Math.max(1, Math.ceil(((arr[0] ?? t) + this.windowMs - t) / 1000));
    }
    arr.push(t);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    }
    return 0;
  }
  /** Retry-after seconds if already at/over `max` WITHOUT recording a hit, else 0. */
  peek(key: string, max: number): number {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length < max) return 0;
    return Math.max(1, Math.ceil(((arr[0] ?? t) + this.windowMs - t) / 1000));
  }
}

export interface AuthMiddlewareDeps {
  /** Overrides for the key resolver (tests inject fakes; production uses the gateway + ownership table). */
  resolver?: { resolve: (key: string) => Promise<KeyResolution> };
  resolverDeps?: Partial<ApiKeyResolverDeps>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: Pick<Logger, 'debug' | 'warn'>;
  verifyJwt?: (token: string) => Promise<{ userId: string }>;
}

function sendKeyError(res: Response, r: Exclude<KeyResolution, { ok: true }>): void {
  if (r.status === 429) res.setHeader('Retry-After', String(r.retryAfterSec));
  res.status(r.status).json({ error: r.message, code: r.code });
}

export function createRequireAuthOrApiKey(deps: AuthMiddlewareDeps = {}) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const verifyJwt = deps.verifyJwt ?? verifyAuthTokenRemote;
  const failures = new SlidingLimiter(5 * 60_000, now);
  const perAccount = new SlidingLimiter(60_000, now);
  const resolver =
    deps.resolver ??
    createApiKeyResolver({
      gatewayUrl: env.REALTIME_TTS_GATEWAY_URL || 'https://api.readaloudai.org',
      fetchImpl: fetch,
      lookupOwner: lookupOwnerFromDb,
      now,
      cacheTtlMs: envInt(env.RTTS_KEY_CACHE_TTL_MS, 10_000),
      timeoutMs: envInt(env.RTTS_KEY_CHECK_TIMEOUT_MS, 8_000) || 8_000,
      ...deps.resolverDeps,
    });

  return async function requireAuthOrApiKey(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
    // 1. Gateway-forwarded API key identity (MCP path) - unchanged. Cheap local comparison, no network call.
    const forwarded = resolveGatewayForwardedIdentity(req);
    if (forwarded) {
      req.userId = forwarded.id;
      req.user = { id: forwarded.id };
      req.authMethod = 'gateway-key';
      log.debug({ userId: forwarded.id, via: forwarded.via }, 'Authenticated via gateway-forwarded API key');
      next();
      return;
    }

    // 2. Public API key (rtts_ bearer or xi-api-key), only when the flag is on.
    if (apiKeyAuthEnabled(env)) {
      const key = extractPublicApiKey(req);
      if (key) {
        const ip = String(req.ip ?? 'unknown');
        const maxFails = envInt(env.RTTS_KEY_MAX_FAILURES_PER_5MIN, 30) || 30;
        const blocked = failures.peek(`ip:${ip}`, maxFails);
        if (blocked) {
          res.setHeader('Retry-After', String(blocked));
          res.status(429).json({ error: 'Too many invalid API key attempts. Try again later.', code: 'rate_limited' });
          return;
        }
        let r: KeyResolution;
        try {
          r = await resolver.resolve(key);
        } catch {
          r = { ok: false, status: 503, code: 'key_check_unavailable', message: 'Could not verify the API key right now. Try again shortly.' };
        }
        if (!r.ok) {
          // Count only rejections that look like guessing (bad / unlinked key), not upstream outages or billing.
          if (r.status === 401 || r.status === 403) failures.hit(`ip:${ip}`, maxFails);
          log.debug({ status: r.status, code: r.code }, 'Public API key rejected');
          sendKeyError(res, r);
          return;
        }
        // Per-account ceiling across all of the account's keys and all families (backstop; routers keep their own limits).
        const maxPerMin = envInt(env.RTTS_KEY_RATE_PER_MIN, 300) || 300;
        const retry = perAccount.hit(`acct:${r.userId}`, maxPerMin);
        if (retry) {
          res.setHeader('Retry-After', String(retry));
          res.status(429).json({ error: 'Too many requests for this account. Please slow down.', code: 'rate_limited' });
          return;
        }
        req.userId = r.userId;
        req.user = { id: r.userId };
        req.authMethod = 'api-key';
        req.apiKeyId = r.keyId;
        log.debug({ userId: r.userId, keyId: r.keyId }, 'Authenticated via public API key');
        next();
        return;
      }
    }

    // 3. Real Supabase JWT. A public key (rtts_...) is never a JWT: refuse it here instead of sending a customer's
    //    key to Supabase's auth endpoint (and into that client's error logs) when the key path is switched off.
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (token.startsWith(RTTS_KEY_PREFIX)) throw new Error('public API key not enabled');
      const { userId } = await verifyJwt(token);
      req.userId = userId;
      req.user = { id: userId };
      req.authMethod = 'jwt';
      next();
      return;
    } catch (err) {
      log.debug({ err }, 'requireAuthOrApiKey: no valid JWT and no valid gateway-forwarded identity');
      res.status(401).json({ error: 'Sign in required, or provide a valid API key.' });
    }
  };
}

/**
 * Accepts a real Supabase JWT (Authorization: Bearer <jwt>), the gateway-forwarded-secret identity headers
 * (MCP), or - when RTTS_KEY_AUTH_ENABLED is on - the public rtts_ API key as `Authorization: Bearer rtts_...`
 * or `xi-api-key`. Rejects everything else with 401. No default user, no dev-mode bypass, ever: this sits in
 * front of billed endpoints and must fail closed.
 */
export const requireAuthOrApiKey = createRequireAuthOrApiKey();
