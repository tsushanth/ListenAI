// POST /api/webhooks/revenuecat: RevenueCat -> backend entitlement sync (Android/iOS subscribers count as 'paid' for
// consent-gated voice cloning). Auth: the Authorization header configured in the RevenueCat dashboard must equal
// env REVENUECAT_WEBHOOK_AUTH (503 when unset: fail closed). RevenueCat expects 200 for success and retries any other
// status 5 times (5,10,20,40,80 min), so permanently-ignorable events return 200 and store failures return 500.
import { Router, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { configFromEnv, interpretEvent, type MapConfig, type RcEvent } from '../lib/revenuecat/events.js';
import { supabaseRevenueCatStore, type RevenueCatStore } from '../lib/revenuecat/store.js';

const log = logger.child({ module: 'revenuecatWebhook' });
export const MAX_BODY_BYTES = 64 * 1024;

export function authOk(header: string | undefined, secret: string): boolean {
  if (!header) return false;
  // Hash both sides so lengths match and timingSafeEqual leaks nothing about the secret length.
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export interface RevenueCatWebhookDeps {
  store: RevenueCatStore;
  secret: () => string | undefined;
  config: () => MapConfig;
}

export function createRevenueCatWebhookRouter(deps: RevenueCatWebhookDeps): Router {
  const router = Router();
  router.post('/revenuecat', async (req: Request, res: Response): Promise<void> => {
    const secret = deps.secret();
    if (!secret) { log.error('REVENUECAT_WEBHOOK_AUTH not set; rejecting'); res.status(503).json({ error: 'Webhook not configured' }); return; }
    if (!authOk(req.headers.authorization, secret)) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const raw = req.body;
    if (!Buffer.isBuffer(raw)) { res.status(400).json({ error: 'Expected application/json body' }); return; }
    if (raw.length === 0 || raw.length > MAX_BODY_BYTES) { res.status(400).json({ error: 'Invalid body size' }); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'Invalid JSON' }); return; }
    const event = (parsed as { event?: unknown } | null)?.event;
    if (!event || typeof event !== 'object' || Array.isArray(event)) { res.status(400).json({ error: 'Missing event' }); return; }

    const ev = event as RcEvent;
    const decision = interpretEvent(ev, deps.config());
    if (decision.kind === 'ignore') {
      log.info({ type: ev.type, eventId: ev.id, reason: decision.reason }, 'revenuecat event ignored');
      res.status(200).json({ ok: true, ignored: decision.reason });
      return;
    }
    try {
      const results: string[] = [];
      for (const rec of decision.records) {
        const r = await deps.store.apply(rec);
        results.push(r);
        log.info({ type: rec.eventType, eventId: rec.eventId, userId: rec.userId, status: rec.status, plan: rec.planId, result: r }, 'revenuecat event processed');
      }
      res.status(200).json({ ok: true, result: results.length === 1 ? results[0] : results });
    } catch (err) {
      log.error({ err, eventId: ev.id }, 'revenuecat event store failure');
      res.status(500).json({ error: 'Processing failed' }); // RevenueCat retries
    }
  });
  return router;
}

export const revenueCatWebhookRouter = createRevenueCatWebhookRouter({
  store: supabaseRevenueCatStore,
  secret: () => process.env.REVENUECAT_WEBHOOK_AUTH,
  config: () => configFromEnv(),
});
