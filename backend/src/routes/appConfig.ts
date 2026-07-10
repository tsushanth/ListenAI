import { Router, Request, Response } from 'express';
import { getPaywallMode } from '../lib/paywallConfig.js';

export const appConfigRouter = Router();

/**
 * GET /api/config
 * Public endpoint — returns app-level configuration flags.
 * No auth required so the app can fetch this before login.
 */
appConfigRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    paywallMode: getPaywallMode(),
  });
});
