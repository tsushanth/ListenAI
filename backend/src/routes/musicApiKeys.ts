// Management endpoints for text-to-music persistent API keys. Auth is
// applied at the mount site in index.ts (requireRealAuth — session-only, NOT
// requireMusicAuth), matching the pattern in routes/textToMusic.ts, rather
// than baked into this router — minting or revoking API keys must always
// require a real signed-in session, so a single leaked API key can't be used
// to mint more keys or lock the real owner out.
import { Router, Response, NextFunction, Request } from 'express';
import { createMusicApiKey, listMusicApiKeys, revokeMusicApiKey } from '../lib/musicApiKeys.js';
import { logger } from '../lib/logger.js';

const routeLogger = logger.child({ module: 'music-api-keys' });

interface StrictAuthedRequest extends Request {
  userId?: string;
}

function asyncHandler(fn: (req: StrictAuthedRequest, res: Response) => Promise<void>) {
  return (req: StrictAuthedRequest, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

export const musicApiKeysRouter = Router();

musicApiKeysRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const keys = await listMusicApiKeys(req.userId!);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        created_at: k.created_at,
        revoked: !!k.revoked_at,
      })),
    });
  })
);

musicApiKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { id, rawKey } = await createMusicApiKey(req.userId!);
    routeLogger.info({ userId: req.userId, keyId: id }, 'Music API key created');
    // The raw key is returned exactly once, here, and never again — the
    // backend only ever stores/returns its hash and prefix from this point on.
    res.status(201).json({ id, key: rawKey });
  })
);

musicApiKeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const revoked = await revokeMusicApiKey(req.userId!, req.params.id!);
    if (!revoked) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    routeLogger.info({ userId: req.userId, keyId: req.params.id }, 'Music API key revoked');
    res.status(204).send();
  })
);
