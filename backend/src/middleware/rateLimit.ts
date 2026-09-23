import rateLimit from 'express-rate-limit';
import { config, TIER_LIMITS } from '../lib/config.js';
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest, SubscriptionTier } from '../types/index.js';

// ============================================================================
// Rate Limiter Configurations
// ============================================================================

/**
 * Key generator that uses user ID if authenticated, otherwise IP.
 */
function keyGenerator(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user?.id) {
    return `user:${authReq.user.id}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Get rate limit based on user's tier.
 */
function getTierRateLimit(tier: SubscriptionTier): number {
  return TIER_LIMITS[tier]?.requests_per_minute ?? TIER_LIMITS.free.requests_per_minute;
}

/**
 * Standard rate limiter for most endpoints.
 * 60 requests per minute.
 * Skips job polling routes (handled by jobPollingRateLimit).
 */
export const standardRateLimit = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for job polling routes - they have their own limiter
    // This prevents polling from consuming the user's standard API quota
    return req.path.match(/^\/tts\/job\/[^/]+$/) !== null && req.method === 'GET';
  },
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many requests, please try again later',
  },
});

/**
 * Tier-aware rate limiter for TTS endpoint.
 * Limits vary by subscription tier:
 * - Free: 5 req/min
 * - Basic: 15 req/min
 * - Pro: 30 req/min
 * - Unlimited: 60 req/min
 */
const ttsRateLimiters: Record<string, ReturnType<typeof rateLimit>> = {};

// Pre-create rate limiters for each tier
for (const tier of ['free', 'basic', 'pro', 'unlimited'] as const) {
  ttsRateLimiters[tier] = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: TIER_LIMITS[tier].requests_per_minute,
    keyGenerator: (req) => `tts:${keyGenerator(req)}:${tier}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'RATE_LIMITED',
      message: `TTS rate limit exceeded (${TIER_LIMITS[tier].requests_per_minute} req/min for ${tier} tier). Upgrade for higher limits.`,
    },
  });
}

/**
 * Check if a request is for job polling/cancel (should skip TTS rate limits).
 */
function isJobPollingRequest(req: Request): boolean {
  // Match /job/:jobId for GET (polling) or /job/:jobId/cancel for POST
  return /^\/job\/[a-f0-9-]+(?:\/cancel)?$/.test(req.path);
}

/**
 * Dynamic TTS rate limiter that applies tier-specific limits.
 * Looks up user's tier from database and applies appropriate rate limit.
 * This middleware should be used AFTER authentication.
 *
 * IMPORTANT: Skips rate limiting for job polling routes (/job/:jobId)
 * since those are handled by jobPollingRateLimit.
 */
export async function ttsRateLimitByTier(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Skip rate limiting for job polling/cancel routes
  // These are handled by jobPollingRateLimit middleware
  if (isJobPollingRequest(req)) {
    return next();
  }

  const authReq = req as AuthenticatedRequest & { userTier?: SubscriptionTier };

  // Get tier from request if already attached, otherwise look up from DB
  let tier: SubscriptionTier = 'free';

  if (authReq.userTier) {
    tier = authReq.userTier;
  } else if (authReq.user?.id) {
    // Import here to avoid circular dependency
    const { getUserTier } = await import('../lib/supabaseClient.js');
    try {
      tier = await getUserTier(authReq.user.id);
      authReq.userTier = tier; // Cache for later use
    } catch {
      // Default to free tier on error
      tier = 'free';
    }
  }

  const limiter = ttsRateLimiters[tier] ?? ttsRateLimiters['free']!;
  limiter(req, res, next);
}

/**
 * Default TTS rate limiter (backward compatibility).
 * Uses strictest free tier limits.
 */
export const ttsRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: TIER_LIMITS.free.requests_per_minute,  // 5 req/min for free
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: `TTS rate limit exceeded. Maximum ${TIER_LIMITS.free.requests_per_minute} requests per minute.`,
  },
});

/**
 * Very strict rate limiter for preview endpoint.
 * 10 requests per minute (previews are free, need to prevent abuse).
 */
export const previewRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Preview rate limit exceeded, please try again later',
  },
});

/**
 * Auth rate limiter (applies before authentication).
 * Uses IP-based limiting to prevent brute force.
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  keyGenerator: (req) => req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many authentication attempts',
  },
});

/**
 * Spam protection rate limiter.
 * Very strict: 3 requests per 10 seconds.
 * Applied in addition to tier limits to prevent burst abuse.
 *
 * IMPORTANT: Skips rate limiting for job polling routes (/job/:jobId).
 */
const burstRateLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 3,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many requests in short time. Please slow down.',
  },
});

export function burstRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Skip burst rate limiting for job polling/cancel routes
  if (/^\/job\/[a-f0-9-]+(?:\/cancel)?$/.test(req.path)) {
    return next();
  }
  burstRateLimiter(req, res, next);
}

/**
 * Job status polling rate limiter.
 * More generous: 60 requests per minute (1 per second average).
 * Used for GET /tts/job/:jobId endpoint which is polled automatically
 * by the client and shouldn't count against the user's TTS quota.
 */
export const jobPollingRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute (generous for polling)
  keyGenerator: (req) => `poll:${keyGenerator(req)}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many status polling requests. Please slow down.',
  },
});

/**
 * Rate limiter specific to POST /api/realtime-tts/authorize.
 *
 * requireAuth (see middleware/auth.ts) defaults unauthenticated/invalid-token callers to a shared
 * "pro user" instead of rejecting them — an intentional generous-free-tier design elsewhere in the
 * app, but it means this route (mounted behind requireAuth) is effectively callable by anyone with
 * no real per-user identity, and every successful call mints a session billed against the shared
 * REALTIME_TTS_API_KEY. The general-purpose burstRateLimit (3 req/10s) runs before requireAuth on
 * this route too, but it's IP-keyed only because no user is attached yet at that point, and 3/10s
 * (~18/min) is still cheap enough for an anonymous caller to run up real GPU/CPU cost over time.
 *
 * This limiter is deliberately IP-keyed (never user-keyed) since, for this route, there is no real
 * per-user identity to key on, and stricter than burstRateLimit: unauthenticated legitimate app usage
 * authorizes a session only when the user actually starts playback, which is infrequent per IP.
 *
 * NOTE: this bounds cost, it does not fix the underlying lack of authentication. Must be revisited
 * (real per-user auth, or a proper API key/session-bound quota) before any public, non-invite-only
 * launch — see the comment on realtimeTtsRouter in routes/realtimeTts.ts.
 */
export const realtimeTtsAuthorizeRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 10, // 10 authorize calls per IP per 5 minutes
  keyGenerator: (req) => `rt-tts-authorize:ip:${req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMITED',
    message: 'Too many realtime-tts authorize requests from this address. Please slow down.',
  },
});
