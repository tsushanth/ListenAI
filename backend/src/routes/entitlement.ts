/**
 * GET /api/entitlement: read-only. DEPLOY-ON-MERGE (backend).
 *
 * What the web /success page polls after a Stripe checkout, and what any client can read to see the tier the backend
 * enforces. The tier is getUserTier() (subscriptions.plan_id), the same value quotas and voice gates use.
 *
 * Authentication is strict on purpose. requireAuth() treats a missing or invalid token as a shared default "pro" user, which
 * is right for legacy apps but would tell an anonymous caller they are Pro here. This route answers 401 instead.
 */
import { Router, type Request, type Response } from 'express';
import { authenticateRequest } from '../lib/auth.js';
import { getUserTier } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { sourceIsActive, webProEntitlementEnabled, type SourceRow } from '../lib/webEntitlement.js';
import { supabaseEntitlementStore } from '../lib/webEntitlementStore.js';
import type { SubscriptionTier } from '../types/index.js';

export interface EntitlementDeps {
  authenticate(authHeader: string | undefined): Promise<{ id: string }>;
  getTier(userId: string): Promise<SubscriptionTier>;
  listSources(userId: string): Promise<SourceRow[]>;
  webProEnabled(): boolean;
  nowMs(): number;
}

const realDeps: EntitlementDeps = {
  authenticate: (h) => authenticateRequest(h),
  getTier: getUserTier,
  listSources: (id) => supabaseEntitlementStore.listSources(id),
  webProEnabled: () => webProEntitlementEnabled(),
  nowMs: () => Date.now(),
};

export function createEntitlementRouter(deps: EntitlementDeps = realDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');

    let userId: string;
    try {
      userId = (await deps.authenticate(req.headers.authorization)).id;
    } catch {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const tier = await deps.getTier(userId);
      let sources: SourceRow[] = [];
      try {
        sources = await deps.listSources(userId);
      } catch (err) {
        // The ledger table may not exist yet (migration 036 not applied). The tier is still correct, so still answer.
        logger.warn({ err }, 'entitlement: could not read entitlement_sources');
      }
      const now = deps.nowMs();
      res.json({
        tier,
        active: tier !== 'free',
        web_pro_enabled: deps.webProEnabled(),
        sources: sources.map((s) => ({
          source: s.source,
          tier: s.tier,
          status: s.status,
          active: sourceIsActive(s, now),
          current_period_end: s.current_period_end,
        })),
      });
    } catch (err) {
      logger.error({ err }, 'entitlement lookup failed');
      res.status(500).json({ error: 'entitlement_lookup_failed' });
    }
  });

  return router;
}

export const entitlementRouter = createEntitlementRouter();
