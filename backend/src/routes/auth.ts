import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { ValidationError, AppError } from '../types/index.js';

const router = Router();

// ============================================================================
// Request Schemas
// ============================================================================

const appleSignInSchema = z.object({
  id_token: z.string().min(1, 'Apple ID token is required'),
  nonce: z.string().optional(),
  user: z.object({
    email: z.string().email().optional(),
    given_name: z.string().optional(),
    family_name: z.string().optional(),
  }).optional(),
});

const googleSignInSchema = z.object({
  id_token: z.string().min(1, 'Google ID token is required'),
  access_token: z.string().optional(),
});

const linkDeviceSchema = z.object({
  device_id: z.string().min(1, 'Device ID is required'),
});

const refreshTokenSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

// ============================================================================
// Response Types
// ============================================================================

interface AuthResponse {
  user: {
    id: string;
    email: string | null;
    display_name: string | null;
    avatar_url: string | null;
    created_at: string;
  };
  session: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get or create app_users record for a Supabase auth user.
 * This ensures every authenticated user has a corresponding app_users record.
 */
async function ensureAppUser(authUserId: string, email: string | null, displayName: string | null): Promise<void> {
  // Check if user exists
  const { data: existingUser, error: fetchError } = await supabase
    .from('app_users')
    .select('id')
    .eq('id', authUserId)
    .single();

  if (fetchError && fetchError.code !== 'PGRST116') {
    // PGRST116 = not found, which is expected for new users
    logger.error({ error: fetchError, authUserId }, 'Error checking app_users');
    throw fetchError;
  }

  if (!existingUser) {
    // Create new app_users record
    const { error: insertError } = await supabase
      .from('app_users')
      .insert({
        id: authUserId,
        display_name: displayName,
        email: email,
      });

    if (insertError) {
      // Ignore duplicate key error (race condition)
      if (!insertError.message?.includes('duplicate key')) {
        logger.error({ error: insertError, authUserId }, 'Error creating app_users record');
        throw insertError;
      }
    } else {
      logger.info({ authUserId, email }, 'Created app_users record for new user');
    }
  }
}

/**
 * Link a device ID to an authenticated user.
 * This allows migrating anonymous data to the authenticated account.
 */
async function linkDeviceToUser(userId: string, deviceId: string): Promise<void> {
  // Update any cloned_voices owned by this device_id to the authenticated user
  const { error: voicesError } = await supabase
    .from('cloned_voices')
    .update({ user_id: userId })
    .eq('user_id', deviceId);

  if (voicesError) {
    logger.warn({ error: voicesError, userId, deviceId }, 'Error migrating cloned voices');
  }

  // Update any shared_voices owned by this device_id
  const { error: sharedError } = await supabase
    .from('shared_voices')
    .update({ owner_user_id: userId })
    .eq('owner_user_id', deviceId);

  if (sharedError) {
    logger.warn({ error: sharedError, userId, deviceId }, 'Error migrating shared voices');
  }

  // Record the device linking
  const { error: linkError } = await supabase
    .from('user_devices')
    .upsert({
      user_id: userId,
      device_id: deviceId,
      linked_at: new Date().toISOString(),
    }, {
      onConflict: 'device_id',
    });

  if (linkError) {
    logger.warn({ error: linkError, userId, deviceId }, 'Error recording device link');
  }

  logger.info({ userId, deviceId }, 'Device linked to user');
}

// ============================================================================
// Routes
// ============================================================================

/**
 * POST /api/auth/apple
 * Sign in with Apple ID token.
 * The iOS app uses Sign in with Apple to get an ID token, which is sent here.
 * Supabase Auth verifies the token and creates/returns a session.
 */
router.post('/apple', async (req: Request, res: Response) => {
  try {
    const validation = appleSignInSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError('Invalid request', { errors: validation.error.flatten() });
    }

    const { id_token, nonce, user } = validation.data;

    // Sign in with Supabase using Apple ID token
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: id_token,
      nonce: nonce,
    });

    if (error) {
      logger.error({ error: error.message }, 'Apple sign-in failed');
      throw new AppError(401, 'AUTH_FAILED', error.message);
    }

    if (!data.user || !data.session) {
      throw new AppError(401, 'AUTH_FAILED', 'No user or session returned');
    }

    // Determine display name from Apple user info or email
    const displayName = user?.given_name
      ? `${user.given_name}${user.family_name ? ' ' + user.family_name : ''}`
      : data.user.email?.split('@')[0] ?? null;

    // Ensure app_users record exists
    await ensureAppUser(data.user.id, data.user.email ?? null, displayName);

    // If device_id header present, link device to user
    const deviceId = req.headers['x-device-id'] as string;
    if (deviceId) {
      await linkDeviceToUser(data.user.id, deviceId);
    }

    const response: AuthResponse = {
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
        display_name: displayName,
        avatar_url: data.user.user_metadata?.avatar_url ?? null,
        created_at: data.user.created_at,
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
      },
    };

    logger.info({ userId: data.user.id, email: data.user.email }, 'Apple sign-in successful');
    res.json(response);
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ error }, 'Unexpected error in Apple sign-in');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
});

/**
 * POST /api/auth/google
 * Sign in with Google ID token.
 * Both iOS and Android can use Google Sign-In to get an ID token.
 */
router.post('/google', async (req: Request, res: Response) => {
  try {
    const validation = googleSignInSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError('Invalid request', { errors: validation.error.flatten() });
    }

    const { id_token, access_token } = validation.data;

    // Sign in with Supabase using Google ID token
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'google',
      token: id_token,
      access_token: access_token,
    });

    if (error) {
      logger.error({ error: error.message }, 'Google sign-in failed');
      throw new AppError(401, 'AUTH_FAILED', error.message);
    }

    if (!data.user || !data.session) {
      throw new AppError(401, 'AUTH_FAILED', 'No user or session returned');
    }

    // Get display name from Google user metadata
    const displayName = data.user.user_metadata?.full_name
      ?? data.user.user_metadata?.name
      ?? data.user.email?.split('@')[0]
      ?? null;

    // Ensure app_users record exists
    await ensureAppUser(data.user.id, data.user.email ?? null, displayName);

    // If device_id header present, link device to user
    const deviceId = req.headers['x-device-id'] as string;
    if (deviceId) {
      await linkDeviceToUser(data.user.id, deviceId);
    }

    const response: AuthResponse = {
      user: {
        id: data.user.id,
        email: data.user.email ?? null,
        display_name: displayName,
        avatar_url: data.user.user_metadata?.avatar_url ?? data.user.user_metadata?.picture ?? null,
        created_at: data.user.created_at,
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
      },
    };

    logger.info({ userId: data.user.id, email: data.user.email }, 'Google sign-in successful');
    res.json(response);
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ error }, 'Unexpected error in Google sign-in');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh an expired access token using a refresh token.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const validation = refreshTokenSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError('Invalid request', { errors: validation.error.flatten() });
    }

    const { refresh_token } = validation.data;

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    });

    if (error) {
      logger.error({ error: error.message }, 'Token refresh failed');
      throw new AppError(401, 'AUTH_FAILED', error.message);
    }

    if (!data.session) {
      throw new AppError(401, 'AUTH_FAILED', 'No session returned');
    }

    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ error }, 'Unexpected error in token refresh');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
});

/**
 * GET /api/auth/me
 * Get the current authenticated user's info.
 * Requires Authorization header with valid access token.
 */
router.get('/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Authorization header required');
    }

    const token = authHeader.substring(7);

    // Get user from Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new AppError(401, 'AUTH_FAILED', 'Invalid or expired token');
    }

    // Get app_users data
    const { data: appUser } = await supabase
      .from('app_users')
      .select('display_name, avatar_url, preferred_voice_id, default_playback_speed')
      .eq('id', user.id)
      .single();

    res.json({
      id: user.id,
      email: user.email ?? null,
      display_name: appUser?.display_name ?? user.user_metadata?.full_name ?? null,
      avatar_url: appUser?.avatar_url ?? user.user_metadata?.avatar_url ?? null,
      preferred_voice_id: appUser?.preferred_voice_id ?? null,
      default_playback_speed: appUser?.default_playback_speed ?? 1.0,
      provider: user.app_metadata?.provider ?? 'unknown',
      created_at: user.created_at,
    });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ error }, 'Unexpected error in get user');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
});

/**
 * POST /api/auth/link-device
 * Link a device ID to the authenticated user.
 * This migrates any data created under the device ID to the authenticated account.
 */
router.post('/link-device', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Authorization header required');
    }

    const token = authHeader.substring(7);

    // Get user from Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new AppError(401, 'AUTH_FAILED', 'Invalid or expired token');
    }

    const validation = linkDeviceSchema.safeParse(req.body);
    if (!validation.success) {
      throw new ValidationError('Invalid request', { errors: validation.error.flatten() });
    }

    const { device_id } = validation.data;

    await linkDeviceToUser(user.id, device_id);

    res.json({
      success: true,
      message: 'Device linked successfully',
      user_id: user.id,
    });
  } catch (error) {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code, message: error.message });
      return;
    }
    logger.error({ error }, 'Unexpected error in link device');
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  }
});

/**
 * POST /api/auth/sign-out
 * Sign out the current user (invalidates the refresh token).
 */
router.post('/sign-out', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth header = already signed out
      res.json({ success: true });
      return;
    }

    const token = authHeader.substring(7);

    // Sign out via Supabase (this invalidates the session)
    const { error } = await supabase.auth.admin.signOut(token);

    if (error) {
      // Log but don't fail - user might already be signed out
      logger.warn({ error: error.message }, 'Sign out error (non-critical)');
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Unexpected error in sign out');
    // Still return success - sign out should always "succeed" from client perspective
    res.json({ success: true });
  }
});

export const authRouter = router;
