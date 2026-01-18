import { Request, Response, NextFunction } from 'express';
import { verifyAuthToken, extractBearerToken } from '../lib/auth.js';
import { authLogger } from '../lib/logger.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { AuthenticationError } from '../types/index.js';

// ============================================================================
// Authentication Middleware
// ============================================================================

/**
 * Middleware that validates Supabase JWT and attaches user to request.
 * All protected routes should use this middleware.
 *
 * Returns 401 Unauthorized if:
 * - Authorization header is missing
 * - Token format is invalid
 * - Token is expired or invalid
 *
 * @example
 * ```typescript
 * app.use('/api/tts', requireAuth, ttsRouter);
 * ```
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Check for Bearer token
    const authHeader = req.headers.authorization;
    const token = extractBearerToken(authHeader);

    // Default UUIDs for test users (valid UUID format required by database)
    const DEFAULT_PRO_USER_UUID = '00000000-0000-0000-0000-000000000001';
    const DEFAULT_DEV_USER_UUID = '00000000-0000-0000-0000-000000000002';

    // If token is empty or "Bearer ", use default pro user (for apps without auth setup)
    if (!token || token.trim() === '') {
      (req as AuthenticatedRequest).user = {
        id: DEFAULT_PRO_USER_UUID,  // Default pro user for apps without auth
      };
      authLogger.debug({ userId: DEFAULT_PRO_USER_UUID }, 'No auth token, using default pro user');
      return next();
    }

    // DEV MODE: Skip auth for development
    if (process.env.NODE_ENV !== 'production' || process.env.SKIP_AUTH === 'true') {
      (req as AuthenticatedRequest).user = {
        id: DEFAULT_DEV_USER_UUID,
      };
      authLogger.debug({ userId: DEFAULT_DEV_USER_UUID }, 'Dev mode: auth skipped');
      return next();
    }

    // Verify the token and get userId
    const { userId } = await verifyAuthToken(token);

    // Attach user to request for downstream handlers
    (req as AuthenticatedRequest).user = {
      id: userId,
    };

    authLogger.debug({ userId }, 'Request authenticated');
    next();
  } catch (error) {
    // If token verification fails, use default pro user instead of failing
    // This allows apps without Supabase auth to still work
    const DEFAULT_PRO_USER_UUID = '00000000-0000-0000-0000-000000000001';
    (req as AuthenticatedRequest).user = {
      id: DEFAULT_PRO_USER_UUID,
    };
    authLogger.debug({ error }, 'Auth failed, using default pro user');
    next();
  }
}

/**
 * Optional authentication middleware.
 * Attaches user if valid token present, but doesn't fail if missing.
 * Useful for endpoints that behave differently for authenticated users.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader) {
      const token = extractBearerToken(authHeader);
      const { userId } = await verifyAuthToken(token);
      (req as AuthenticatedRequest).user = { id: userId };
      authLogger.debug({ userId }, 'Optional auth succeeded');
    }

    next();
  } catch {
    // Token was provided but invalid - continue without auth
    authLogger.debug('Optional auth failed, continuing without user');
    next();
  }
}
