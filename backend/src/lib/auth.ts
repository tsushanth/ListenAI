import * as jose from 'jose';
import axios from 'axios';
import { config } from './config.js';
import { authLogger } from './logger.js';
import type { JWTPayload, AuthenticatedUser } from '../types/index.js';
import { AuthenticationError } from '../types/index.js';

// ============================================================================
// Auth Result Types
// ============================================================================

export interface AuthResult {
  userId: string;
}

// ============================================================================
// JWT Verification (Local - using JWT secret)
// ============================================================================

// Cache for the JWT secret as KeyLike
let jwtSecretKey: Uint8Array | null = null;

/**
 * Get the JWT secret key for verification.
 * Supabase uses a symmetric secret for JWT signing.
 */
function getJWTSecretKey(): Uint8Array {
  if (!jwtSecretKey) {
    jwtSecretKey = new TextEncoder().encode(config.SUPABASE_JWT_SECRET);
  }
  return jwtSecretKey;
}

/**
 * Verify a Supabase JWT locally using the JWT secret.
 * This is faster than remote validation but requires the JWT secret.
 *
 * @param token - The JWT token (without "Bearer " prefix)
 * @returns The decoded JWT payload
 * @throws AuthenticationError if token is invalid
 */
async function verifyTokenLocally(token: string): Promise<JWTPayload> {
  try {
    const secretKey = getJWTSecretKey();

    const { payload } = await jose.jwtVerify(token, secretKey, {
      algorithms: ['HS256'],
      // Supabase sets these claims
      issuer: `${config.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });

    // Validate required claims
    if (!payload.sub) {
      throw new AuthenticationError('Token missing subject claim');
    }

    return payload as unknown as JWTPayload;
  } catch (error) {
    if (error instanceof jose.errors.JWTExpired) {
      authLogger.debug('JWT expired');
      throw new AuthenticationError('Token expired');
    }

    if (error instanceof jose.errors.JWTClaimValidationFailed) {
      authLogger.debug({ error: error.message }, 'JWT claim validation failed');
      throw new AuthenticationError('Invalid token claims');
    }

    if (error instanceof jose.errors.JWSSignatureVerificationFailed) {
      authLogger.warn('JWT signature verification failed');
      throw new AuthenticationError('Invalid token signature');
    }

    if (error instanceof AuthenticationError) {
      throw error;
    }

    authLogger.error({ error }, 'Unexpected JWT verification error');
    throw new AuthenticationError('Token verification failed');
  }
}

// ============================================================================
// Remote Validation (using Supabase API)
// ============================================================================

interface SupabaseUser {
  id: string;
  email?: string;
  role?: string;
  aud?: string;
}

/**
 * Verify a Supabase JWT by calling Supabase's /auth/v1/user endpoint.
 * This validates the token against Supabase's auth server.
 *
 * @param token - The JWT token (without "Bearer " prefix)
 * @returns The user data from Supabase
 * @throws AuthenticationError if token is invalid
 */
async function verifyTokenRemotely(token: string): Promise<SupabaseUser> {
  try {
    const response = await axios.get<SupabaseUser>(
      `${config.SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        },
        timeout: 5000, // 5 second timeout
      }
    );

    if (!response.data?.id) {
      throw new AuthenticationError('Invalid user data from Supabase');
    }

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 401) {
        authLogger.debug('Supabase rejected token');
        throw new AuthenticationError('Invalid or expired token');
      }
      if (error.response?.status === 403) {
        throw new AuthenticationError('Token not authorized');
      }
      if (error.code === 'ECONNABORTED') {
        authLogger.error('Supabase auth timeout');
        throw new AuthenticationError('Authentication service timeout');
      }
      authLogger.error({ status: error.response?.status }, 'Supabase auth error');
    }

    if (error instanceof AuthenticationError) {
      throw error;
    }

    authLogger.error({ error }, 'Unexpected remote verification error');
    throw new AuthenticationError('Token verification failed');
  }
}

// ============================================================================
// Main Auth Functions
// ============================================================================

/**
 * Verify an auth token and return the user ID.
 * Uses local JWT verification by default (faster).
 *
 * @param token - The JWT token (without "Bearer " prefix)
 * @returns Object containing the userId
 * @throws AuthenticationError if token is invalid
 *
 * @example
 * ```typescript
 * const token = req.headers.authorization?.replace('Bearer ', '');
 * const { userId } = await verifyAuthToken(token);
 * ```
 */
export async function verifyAuthToken(token: string): Promise<AuthResult> {
  if (!token) {
    throw new AuthenticationError('Token required');
  }

  // Use local verification (faster, requires JWT secret)
  const payload = await verifyTokenLocally(token);

  authLogger.debug({ userId: payload.sub }, 'Token verified');

  return {
    userId: payload.sub,
  };
}

/**
 * Verify an auth token using Supabase's remote API.
 * Use this if you don't have the JWT secret or want to validate against Supabase.
 *
 * @param token - The JWT token (without "Bearer " prefix)
 * @returns Object containing the userId
 * @throws AuthenticationError if token is invalid
 */
export async function verifyAuthTokenRemote(token: string): Promise<AuthResult> {
  if (!token) {
    throw new AuthenticationError('Token required');
  }

  const user = await verifyTokenRemotely(token);

  authLogger.debug({ userId: user.id }, 'Token verified (remote)');

  return {
    userId: user.id,
  };
}

/**
 * Verify a Supabase JWT and extract the full payload.
 * @deprecated Use verifyAuthToken for simpler interface
 */
export async function verifyToken(token: string): Promise<JWTPayload> {
  return verifyTokenLocally(token);
}

/**
 * Extract the Bearer token from an Authorization header.
 *
 * @param authHeader - The Authorization header value
 * @returns The token string
 * @throws AuthenticationError if header is missing or malformed
 */
export function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader) {
    throw new AuthenticationError('Authorization header required');
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    throw new AuthenticationError('Invalid authorization header format');
  }

  const token = parts[1];
  if (!token) {
    throw new AuthenticationError('Token not provided');
  }

  return token;
}

/**
 * Authenticate a request by verifying the JWT.
 *
 * @param authHeader - The Authorization header value
 * @returns The authenticated user info
 * @throws AuthenticationError if authentication fails
 */
export async function authenticateRequest(
  authHeader: string | undefined
): Promise<AuthenticatedUser> {
  const token = extractBearerToken(authHeader);
  const payload = await verifyToken(token);

  authLogger.debug({ userId: payload.sub }, 'User authenticated');

  return {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
  };
}

/**
 * Validate that a user has a minimum tier level.
 *
 * @param userTier - The user's current tier
 * @param requiredTier - The minimum required tier
 * @returns True if user has sufficient tier
 */
export function hasRequiredTier(
  userTier: string,
  requiredTier: string
): boolean {
  const tierOrder = ['free', 'basic', 'pro', 'unlimited'];
  const userIndex = tierOrder.indexOf(userTier);
  const requiredIndex = tierOrder.indexOf(requiredTier);

  if (userIndex === -1 || requiredIndex === -1) {
    return false;
  }

  return userIndex >= requiredIndex;
}
