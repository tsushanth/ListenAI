// HTTP surface for the self-serve Modal deployment lifecycle (lib/modalDeployments.ts).
//
// Every feature that runs on a per-user Modal app exposes the same three calls under its own path:
//   POST   <feature>/deploy   bring the user's app up (202; poll GET until status is "ready")
//   GET    <feature>/deploy   status of the user's latest deployment, including failed or stopped ones
//   DELETE <feature>/deploy   tear it down (the system also tears down idle and over-age deployments)
// plus GET /api/deployments listing a user's deployments across all features.
// The per-deployment secret is never returned.
import { Router, type Request, type RequestHandler, type Response, type NextFunction } from 'express';
import { getDeploymentManager, SERVICE_SPECS, type DeployLimits, type DeploymentService, type DenyCode } from '../lib/modalDeployments.js';

const DENY_STATUS: Record<DenyCode, number> = {
  payment_required: 402,
  user_cap: 429,
  daily_cap: 429,
  global_cap: 503,
  deployments_disabled: 503,
  not_configured: 503,
  service_unavailable: 503,
};

const uid = (req: Request): string => (req as Request & { userId?: string }).userId!;

export interface MountOptions {
  /**
   * Checked before a deploy is accepted. Return a message to refuse (503), or null to allow. Use it when a feature has
   * its own provisioning gate (for example text-to-music is refused unless a billing price is configured), so a user
   * cannot start GPU resources for something that cannot earn its cost.
   */
  precondition?: () => string | null;
}

/** Adds GET/POST/DELETE `/deploy` for one service to an existing router. `requireUser` must set req.userId. */
export function mountDeploymentRoutes(r: Router, service: DeploymentService, requireUser: RequestHandler, opts: MountOptions = {}): void {
  const label = SERVICE_SPECS[service].label;

  r.get('/deploy', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dep = await getDeploymentManager().getForUser(uid(req), service);
      if (!dep) {
        res.status(404).json({ error: 'No deployment found.' });
        return;
      }
      res.json(dep);
    } catch (e) {
      next(e);
    }
  });

  r.post('/deploy', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refusal = opts.precondition?.() ?? null;
      if (refusal) {
        res.status(503).json({ error: refusal, code: 'service_unavailable' });
        return;
      }
      const out = await getDeploymentManager().deploy(uid(req), service);
      if (out.kind === 'accepted') {
        res.status(202).json(out.deployment);
      } else if (out.kind === 'exists') {
        res.status(409).json({ error: 'You already have an active deployment.', deployment: out.deployment });
      } else {
        res.status(DENY_STATUS[out.code]).json({ error: out.message, code: out.code });
      }
    } catch (e) {
      next(e);
    }
  });

  r.delete('/deploy', requireUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getDeploymentManager().teardownForUser(uid(req), service, 'user');
      if (result === 'none') {
        res.status(404).json({ error: 'No active deployment to tear down.' });
        return;
      }
      // 'stopping' means Modal did not confirm yet; the system keeps retrying, so the user need not call again.
      res.json({ deleted: true, status: result, message: result === 'stopped' ? `Your ${label} deployment was torn down.` : `Tearing down your ${label} deployment.` });
    } catch (e) {
      next(e);
    }
  });
}

/** GET /api/deployments: the caller's deployments across every feature, plus the limits that apply. */
export function createDeploymentsListRouter(): Router {
  const r = Router();
  r.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as Request & { userId?: string }).userId;
      if (!userId) {
        res.status(401).json({ error: 'Sign in required.' });
        return;
      }
      const mgr = getDeploymentManager();
      const l: DeployLimits = mgr.limits;
      res.json({
        deployments: await mgr.listForUser(userId),
        limits: {
          idle_timeout_minutes: Math.round(l.idleTtlMs / 60_000),
          max_age_minutes: Math.round(l.maxAgeMs / 60_000),
          max_active_per_user: l.maxActivePerUser,
          max_deploys_per_day: l.maxDeploysPerUserPerDay,
          payment_method_required: l.requirePaymentMethod,
        },
      });
    } catch (e) {
      next(e);
    }
  });
  return r;
}

export const deploymentsListRouter: Router = createDeploymentsListRouter();
