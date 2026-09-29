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

const log = logger.child({ module: 'apiKeyAuth' });

export interface AuthedRequest extends Request {
  userId?: string;
  /** Also set as `req.user.id`, mirroring middleware/auth.ts's requireAuth shape — the four routes this
   *  was built for read the resolved identity both ways (audiobooks.ts/dub.ts read `req.user.id`;
   *  soundEffects.ts/stt.ts's own inline check reads `req.userId`), so this sets both rather than making
   *  each route file adapt to one convention. */
  user?: { id: string };
  /** How this request's identity was established — routes that bill differently per path can branch on it. */
  authMethod?: 'jwt' | 'gateway-key';
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

/**
 * Accepts EITHER a real Supabase JWT (Authorization: Bearer <jwt>, verified remotely against Supabase —
 * same call as requireRealAuth) OR the gateway-forwarded-secret + resolved-identity headers described
 * above. Rejects everything else with 401. No default user, no dev-mode bypass, ever — this sits in front
 * of billed endpoints and must fail closed.
 */
export async function requireAuthOrApiKey(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // 1. Gateway-forwarded API key identity — checked first since it's a cheap local comparison, no network
  //    call, and lets a correctly-forwarded MCP request skip JWT parsing entirely.
  const forwarded = resolveGatewayForwardedIdentity(req);
  if (forwarded) {
    req.userId = forwarded.id;
    req.user = { id: forwarded.id };
    req.authMethod = 'gateway-key';
    log.debug({ userId: forwarded.id, via: forwarded.via }, 'Authenticated via gateway-forwarded API key');
    next();
    return;
  }

  // 2. Real Supabase JWT.
  try {
    const token = extractBearerToken(req.headers.authorization);
    const { userId } = await verifyAuthTokenRemote(token);
    req.userId = userId;
    req.user = { id: userId };
    req.authMethod = 'jwt';
    next();
    return;
  } catch (err) {
    log.debug({ err }, 'requireAuthOrApiKey: no valid JWT and no valid gateway-forwarded identity');
    res.status(401).json({ error: 'Sign in required, or provide a valid API key.' });
  }
}
