import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../lib/logger.js';
import { supabase, getSubscription } from '../lib/supabaseClient.js';
import { TIER_LIMITS_CHARS } from '../lib/config.js';
import type {
  AuthenticatedRequest,
  SubscriptionTier,
  SubscriptionStatus,
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

export const subscriptionRouter = Router();

// ============================================================================
// Types
// ============================================================================

interface SyncSubscriptionBody {
  product_id: string;
  transaction_id: string;
  original_transaction_id: string;
  purchase_date: string;
  expires_date?: string;
  is_trial_period?: boolean;
  cancellation_date?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map App Store product ID to subscription tier.
 */
function productIdToTier(productId: string): SubscriptionTier {
  // Map your App Store product IDs to tiers
  if (productId.includes('weekly') || productId.includes('annual')) {
    return 'pro';
  }
  if (productId.includes('unlimited')) {
    return 'unlimited';
  }
  return 'free';
}

/**
 * Determine subscription status from purchase info.
 */
function determineStatus(
  expiresDate: string | undefined,
  cancellationDate: string | undefined,
  isTrialPeriod: boolean
): SubscriptionStatus {
  if (cancellationDate) {
    return 'canceled';
  }

  if (isTrialPeriod) {
    return 'trialing';
  }

  if (expiresDate) {
    const expiry = new Date(expiresDate);
    if (expiry < new Date()) {
      return 'expired';
    }
  }

  return 'active';
}

// ============================================================================
// POST /subscription/sync - Sync App Store purchase with backend
// ============================================================================

subscriptionRouter.post(
  '/sync',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.id;
    const body = req.body as SyncSubscriptionBody;

    const {
      product_id,
      transaction_id,
      original_transaction_id,
      purchase_date,
      expires_date,
      is_trial_period,
      cancellation_date,
    } = body;

    if (!product_id || !transaction_id) {
      res.status(400).json({ error: 'Missing required fields: product_id, transaction_id' });
      return;
    }

    logger.info({
      userId,
      productId: product_id,
      transactionId: transaction_id,
    }, 'Syncing subscription from App Store');

    // Determine tier and status
    const tier = productIdToTier(product_id);
    const status = determineStatus(expires_date, cancellation_date, is_trial_period ?? false);
    const limits = TIER_LIMITS_CHARS[tier] ?? TIER_LIMITS_CHARS.free;

    // Check if subscription exists
    const existingSubscription = await getSubscription(userId);

    if (existingSubscription) {
      // Update existing subscription
      const { error } = await supabase
        .from('subscriptions')
        .update({
          plan_id: tier,
          status,
          current_period_start: purchase_date,
          current_period_end: expires_date ?? null,
          canceled_at: cancellation_date ?? null,
          updated_at: new Date().toISOString(),
          // Store App Store transaction info in metadata or specific columns if available
        })
        .eq('user_id', userId);

      if (error) {
        logger.error({ error, userId }, 'Failed to update subscription');
        res.status(500).json({ error: 'Failed to update subscription' });
        return;
      }

      logger.info({ userId, tier, status }, 'Subscription updated');
    } else {
      // Create new subscription
      const { error } = await supabase
        .from('subscriptions')
        .insert({
          user_id: userId,
          plan_id: tier,
          status,
          current_period_start: purchase_date,
          current_period_end: expires_date ?? null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (error) {
        logger.error({ error, userId }, 'Failed to create subscription');
        res.status(500).json({ error: 'Failed to create subscription' });
        return;
      }

      logger.info({ userId, tier, status }, 'Subscription created');
    }

    // Update monthly quota limits based on new tier
    const currentMonth = new Date().toISOString().slice(0, 7);
    await supabase
      .from('monthly_quota')
      .upsert({
        user_id: userId,
        month: currentMonth,
        char_limit: limits.monthly,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,month',
      });

    // Update daily quota limits
    const today = new Date().toISOString().split('T')[0];
    await supabase
      .from('daily_quota')
      .upsert({
        user_id: userId,
        date: today,
        char_limit: limits.daily,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,date',
      });

    res.json({
      success: true,
      subscription: {
        tier,
        status,
        expires_at: expires_date ?? null,
      },
      limits: {
        daily: limits.daily,
        monthly: limits.monthly,
      },
    });
  })
);

// ============================================================================
// GET /subscription - Get current subscription status
// ============================================================================

subscriptionRouter.get(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.id;

    const subscription = await getSubscription(userId);

    if (!subscription) {
      res.json({
        tier: 'free',
        status: 'active',
        expires_at: null,
      });
      return;
    }

    res.json({
      tier: subscription.plan_id,
      status: subscription.status,
      expires_at: subscription.current_period_end,
      renews_at: subscription.renews_at,
    });
  })
);

// ============================================================================
// POST /subscription/cancel - Handle subscription cancellation
// ============================================================================

subscriptionRouter.post(
  '/cancel',
  asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user.id;

    logger.info({ userId }, 'Processing subscription cancellation');

    const { error } = await supabase
      .from('subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (error) {
      logger.error({ error, userId }, 'Failed to cancel subscription');
      res.status(500).json({ error: 'Failed to cancel subscription' });
      return;
    }

    res.json({ success: true, message: 'Subscription cancelled' });
  })
);
