/**
 * DELETE /api/account: delete the signed-in user's account and stored data (in-app "Delete account").
 *
 * Authentication is strict on purpose. requireAuth() maps a missing or invalid token to a shared default user, which
 * for a delete route would mean deleting shared data; this route answers 401 instead and takes the user id ONLY from
 * the verified token (never from the body or query).
 *
 * Request:  DELETE /api/account   Authorization: Bearer <supabase access token>
 *           optional JSON body { "acknowledge_active_subscription": true }
 * Responses:
 *   200 { deleted: true, subscriptions: { stripe, play }, ... }   idempotent: repeating a finished deletion is a 200 too
 *   401 { error, code: 'unauthenticated' }
 *   409 { code: 'active_subscription', subscriptions: { stripe, play } }  nothing deleted; resend with the acknowledgement.
 *       This route never cancels a subscription. A Play subscription must be cancelled by the user in Google Play.
 *   502/503 { code } a step failed (voice service, gateway, storage, database); nothing irreversible was left half done
 *       that a retry cannot finish, and the sign-in still works until the final step succeeds.
 */
import { Router, type Request, type Response } from 'express';
import express from 'express';
import { authenticateRemote } from './accountAuth.js';
import { logger } from '../lib/logger.js';
import { AppError } from '../types/index.js';
import { deleteAccount, AccountDeletionError, type AccountDeletionDeps } from '../lib/accountDeletion.js';
import { supabaseAccountStore } from '../lib/accountDeletionStore.js';
import { supabaseCloneStore } from '../lib/voiceCloning/supabaseStore.js';
import { getCloneDeps } from '../lib/voiceCloning/runtime.js';
import { CloneError } from '../lib/voiceCloning/service.js';
import { ServiceUnavailableError } from '../lib/voiceCloning/serviceClient.js';

const log = logger.child({ module: 'account' });

export interface AccountRouterDeps {
  /** Verifies the bearer token against Supabase and returns the user id, or throws. No default-user fallback. */
  authenticate(authHeader: string | undefined): Promise<{ id: string }>;
  deletion: AccountDeletionDeps;
}

const realDeps: AccountRouterDeps = {
  authenticate: authenticateRemote,
  deletion: { store: supabaseAccountStore, cloneStore: supabaseCloneStore, cloneDeps: () => getCloneDeps() },
};

export function createAccountRouter(deps: AccountRouterDeps = realDeps): Router {
  const router = Router();
  router.use(express.json({ limit: '4kb' }));

  router.delete('/', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');

    let userId: string;
    try {
      userId = (await deps.authenticate(req.headers.authorization)).id;
    } catch {
      res.status(401).json({ error: 'Sign in required.', code: 'unauthenticated' });
      return;
    }

    const acknowledge = (req.body as { acknowledge_active_subscription?: unknown } | undefined)?.acknowledge_active_subscription === true;

    try {
      const result = await deleteAccount(deps.deletion, userId, { acknowledgeSubscriptions: acknowledge });
      if (result.status === 'blocked') {
        res.status(409).json({
          error: 'You have an active subscription. Deleting your account does not cancel it.',
          code: 'active_subscription',
          subscriptions: result.subscriptions,
        });
        return;
      }
      log.info({ event: 'account_deleted', userId, voices: result.voicesDeleted, keys: result.gatewayKeysRevoked, objects: result.storageObjectsRemoved, authUser: result.authUser }, 'account deleted');
      res.json({
        deleted: true,
        subscriptions: result.subscriptions,
        voices_deleted: result.voicesDeleted,
      });
    } catch (err) {
      if (err instanceof AccountDeletionError || err instanceof CloneError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof ServiceUnavailableError) {
        log.error({ err, userId }, 'account deletion: voice service unavailable');
        res.status(503).json({ error: 'Your account could not be fully deleted right now. Please try again.', code: 'service_unavailable' });
        return;
      }
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      log.error({ err, userId }, 'account deletion failed');
      res.status(500).json({ error: 'Your account could not be fully deleted. Please try again.', code: 'internal' });
    }
  });

  return router;
}

export const accountRouter = createAccountRouter();
