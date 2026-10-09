// GET /api/admin/dashboard?range=24h|7d|30d. Admin-only (Supabase bearer, Google, confirmed, ADMIN_EMAILS); 404 otherwise.
// Mounted BEFORE the generic /api/admin router (which wants x-admin-key). Not behind requireAuth on purpose.
import { Router, type Request, type Response } from 'express';
import { isAdminBearer } from '../lib/adminBearer.js';
import { buildDashboard, defaultDashboardDeps, parseExcludeEmails, parseRange, type DashboardDeps } from '../lib/adminDashboard.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ module: 'admin-dashboard' });

export function createAdminDashboardRouter(opts: {
  isAdmin?: (authorization?: string) => Promise<boolean>;
  deps?: DashboardDeps;
  excludeEmails?: () => Set<string>;
} = {}): Router {
  const isAdmin = opts.isAdmin ?? ((a?: string) => isAdminBearer(a));
  const deps = opts.deps ?? defaultDashboardDeps;
  const exclude = opts.excludeEmails ?? (() => parseExcludeEmails(process.env.ADMIN_EXCLUDE_EMAILS));
  const router = Router();

  const notFound = (res: Response) => res.status(404).type('text/plain').send('Not found');

  router.get('/', async (req: Request, res: Response) => {
    let admin = false;
    try { admin = await isAdmin(req.headers.authorization); } catch { admin = false; }
    if (!admin) { notFound(res); return; }
    try {
      const range = parseRange(typeof req.query.range === 'string' ? req.query.range : undefined);
      const body = await buildDashboard(deps, { range, excludeEmails: exclude() });
      res.set('Cache-Control', 'no-store').json(body);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'admin dashboard failed');
      res.status(500).set('Cache-Control', 'no-store').json({ error: 'dashboard failed' });
    }
  });
  router.all('/', (_req, res) => notFound(res)); // anything but GET looks like nothing is here
  return router;
}

export const adminDashboardRouter = createAdminDashboardRouter();
