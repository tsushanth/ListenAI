import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { usageLogger } from '../lib/logger.js';
import {
  getSubscription,
  getDailyQuota,
  getMonthlyQuota,
  getRecentUsage,
} from '../lib/supabaseClient.js';
import { TIER_LIMITS_CHARS } from '../lib/config.js';
import type {
  AuthenticatedRequest,
  UsageResponse,
  SubscriptionTier,
} from '../types/index.js';

// ============================================================================
// Async Handler Wrapper
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const usageRouter = Router();

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the next reset time for daily quota (midnight UTC).
 */
function getDailyResetTime(): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

/**
 * Get the next reset time for monthly quota (first of next month).
 */
function getMonthlyResetTime(): string {
  const now = new Date();
  const nextMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return nextMonth.toISOString();
}

/**
 * Get tier limits for a subscription tier.
 */
function getTierLimits(tier: SubscriptionTier): { daily: number; monthly: number } {
  return TIER_LIMITS_CHARS[tier] ?? TIER_LIMITS_CHARS.free;
}

// ============================================================================
// GET /usage - Get current month's usage and quota
// ============================================================================

usageRouter.get('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  usageLogger.debug({ userId }, 'Fetching usage data');

  // Get subscription to determine limits
  const subscription = await getSubscription(userId);
  const tier = subscription?.plan_id ?? 'free';
  const limits = getTierLimits(tier);

  // Get current month's quota
  const monthlyQuota = await getMonthlyQuota(userId);

  const charUsed = monthlyQuota?.char_used ?? 0;
  const charLimit = monthlyQuota?.char_limit ?? limits.monthly;

  // Get current month in YYYY-MM format
  const currentMonth = new Date().toISOString().slice(0, 7);

  res.json({
    current_month: currentMonth,
    char_used: charUsed,
    char_limit: charLimit,
  });
}));

// ============================================================================
// GET /usage/full - Get full usage details (extended endpoint)
// ============================================================================

usageRouter.get('/full', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  usageLogger.debug({ userId }, 'Fetching full usage data');

  // Get subscription
  const subscription = await getSubscription(userId);
  const tier = subscription?.plan_id ?? 'free';
  const status = subscription?.status ?? 'active';
  const limits = getTierLimits(tier);

  // Get current quotas
  const [dailyQuota, monthlyQuota] = await Promise.all([
    getDailyQuota(userId),
    getMonthlyQuota(userId),
  ]);

  const dailyUsed = dailyQuota?.char_used ?? 0;
  const monthlyUsed = monthlyQuota?.char_used ?? 0;

  const dailyLimit = dailyQuota?.char_limit ?? limits.daily;
  const monthlyLimit = monthlyQuota?.char_limit ?? limits.monthly;

  // Calculate estimated minutes remaining
  // ~750 chars per minute of audio
  const charsRemaining = Math.min(dailyLimit - dailyUsed, monthlyLimit - monthlyUsed);
  const estimatedMinutes = Math.max(0, Math.floor(charsRemaining / 750));

  const response: UsageResponse = {
    subscription: {
      tier,
      status,
      current_period_end: subscription?.current_period_end ?? null,
    },
    usage: {
      daily: {
        used: dailyUsed,
        limit: dailyLimit,
        remaining: Math.max(0, dailyLimit - dailyUsed),
        percentage: dailyLimit > 0 ? (dailyUsed / dailyLimit) * 100 : 0,
        resets_at: getDailyResetTime(),
      },
      monthly: {
        used: monthlyUsed,
        limit: monthlyLimit,
        remaining: Math.max(0, monthlyLimit - monthlyUsed),
        percentage: monthlyLimit > 0 ? (monthlyUsed / monthlyLimit) * 100 : 0,
        resets_at: getMonthlyResetTime(),
      },
    },
    estimated_minutes_remaining: estimatedMinutes,
  };

  res.json(response);
}));

// ============================================================================
// GET /usage/history - Get recent usage history
// ============================================================================

usageRouter.get('/history', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  usageLogger.debug({ userId, limit }, 'Fetching usage history');

  const usage = await getRecentUsage(userId, limit);

  res.json({
    history: usage.map((record) => ({
      id: record.id,
      voice_id: record.voice_id,
      provider: record.provider,
      characters: record.characters_used,
      duration_ms: record.audio_duration_ms,
      article_title: record.article_title,
      success: record.success,
      error_message: record.error_message,
      created_at: record.created_at,
    })),
  });
}));

// ============================================================================
// GET /usage/stats - Get usage statistics
// ============================================================================

usageRouter.get('/stats', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  usageLogger.debug({ userId }, 'Fetching usage stats');

  // Get all-time usage from history
  const allUsage = await getRecentUsage(userId, 1000);

  // Calculate stats
  const totalCharacters = allUsage.reduce((sum, r) => sum + r.characters_used, 0);
  const totalRequests = allUsage.length;
  const successfulRequests = allUsage.filter((r) => r.success).length;

  // Provider breakdown
  const byProvider: Record<string, number> = {};
  for (const record of allUsage) {
    byProvider[record.provider] = (byProvider[record.provider] ?? 0) + record.characters_used;
  }

  // Voice breakdown (top 5)
  const byVoice: Record<string, number> = {};
  for (const record of allUsage) {
    if (record.voice_id) {
      byVoice[record.voice_id] = (byVoice[record.voice_id] ?? 0) + record.characters_used;
    }
  }
  const topVoices = Object.entries(byVoice)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([voice_id, characters]) => ({ voice_id, characters }));

  // Daily breakdown (last 30 days)
  const dailyUsage: Record<string, number> = {};
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  for (const record of allUsage) {
    const date = new Date(record.created_at);
    if (date >= thirtyDaysAgo) {
      const dateKey = date.toISOString().split('T')[0]!;
      dailyUsage[dateKey] = (dailyUsage[dateKey] ?? 0) + record.characters_used;
    }
  }

  res.json({
    totals: {
      characters: totalCharacters,
      requests: totalRequests,
      successful_requests: successfulRequests,
      success_rate: totalRequests > 0 ? successfulRequests / totalRequests : 1,
    },
    by_provider: byProvider,
    top_voices: topVoices,
    daily_usage: Object.entries(dailyUsage)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, characters]) => ({ date, characters })),
  });
}));
