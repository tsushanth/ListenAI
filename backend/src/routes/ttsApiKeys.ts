// Lets a signed-in ReadAloud user generate/list/revoke an API key for the
// standalone realtime-tts service. Deliberately does NOT use requireAuth from
// middleware/auth.ts — that middleware falls back to a shared default user UUID
// for any unauthenticated/dev-mode request, which is correct for most of this app
// (device-ID-first UX) but wrong here: this issues a real, billable credential
// against an external service, so it must reject anything without a genuinely
// valid Supabase JWT, full stop.
import { Router, Request, Response, NextFunction } from 'express';
import { verifyAuthToken, extractBearerToken } from '../lib/auth.js';
import { issueGatewayKey, revokeGatewayKey } from '../lib/ttsGatewayClient.js';
import { createApiKeyRecord, listApiKeysForUser, revokeApiKeyRecord, countActiveKeysForUser } from '../lib/ttsApiKeys.js';
import { logger } from '../lib/logger.js';

const routeLogger = logger.child({ module: 'ttsApiKeys.route' });

// Was unbounded — a signed-in user could generate unlimited keys, each spinning
// up its own line item on the gateway's key store with no cost to the caller.
// 5 is arbitrary but generous for real usage (dev/staging/prod-ish splits);
// revisit once real usage patterns exist.
const MAX_ACTIVE_KEYS_PER_USER = 5;

interface StrictAuthedRequest extends Request {
  userId?: string;
}

async function requireRealAuth(req: StrictAuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'Sign in required.' });
      return;
    }
    const { userId } = await verifyAuthToken(token);
    req.userId = userId;
    next();
  } catch (err) {
    routeLogger.debug({ err }, 'requireRealAuth rejected request');
    res.status(401).json({ error: 'Sign in required.' });
  }
}

function asyncHandler(fn: (req: StrictAuthedRequest, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as StrictAuthedRequest, res).catch(next);
  };
}

export const ttsApiKeysRouter = Router();

ttsApiKeysRouter.use(requireRealAuth);

ttsApiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const keys = await listApiKeysForUser(req.userId!);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        label: k.label,
        key_preview: k.key_preview,
        created_at: k.created_at,
        revoked: !!k.revoked_at,
      })),
    });
  })
);

ttsApiKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const activeCount = await countActiveKeysForUser(req.userId!);
    if (activeCount >= MAX_ACTIVE_KEYS_PER_USER) {
      res.status(429).json({
        error: `You already have ${activeCount} active API keys (limit ${MAX_ACTIVE_KEYS_PER_USER}). Revoke one before creating another.`,
      });
      return;
    }
    const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 200) : null;
    const { id: gatewayKeyId, key } = await issueGatewayKey(label || `readaloud user ${req.userId}`);
    const record = await createApiKeyRecord({
      userId: req.userId!,
      gatewayKeyId,
      keyPreview: key.slice(0, 10) + '…',
      label,
    });
    routeLogger.info({ userId: req.userId, recordId: record.id }, 'Issued TTS API key');
    // The raw key is returned exactly once — the frontend must show it to the
    // user immediately and tell them to save it; it is never retrievable again.
    res.json({ id: record.id, key, key_preview: record.key_preview, label: record.label, created_at: record.created_at });
  })
);

ttsApiKeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: 'Missing key id.' });
      return;
    }
    const record = await revokeApiKeyRecord(id, req.userId!);
    if (!record) {
      res.status(404).json({ error: 'Key not found.' });
      return;
    }
    const revoked = await revokeGatewayKey(record.gateway_key_id);
    if (!revoked) {
      // Record was already marked revoked in our DB; log the gateway-side
      // mismatch for follow-up rather than leaving the user stuck.
      routeLogger.warn({ recordId: record.id, gatewayKeyId: record.gateway_key_id }, 'Gateway had no matching key to revoke');
    }
    res.json({ revoked: true });
  })
);
