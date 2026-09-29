// Auth for the text-to-music generation endpoints: accepts EITHER a
// persistent API key (rlm_...) OR a Supabase session token, unlike
// requireRealAuth (ttsApiKeys.ts) which only accepts a session token.
//
// Deliberately NOT used for key management itself (creating/revoking keys) —
// that stays behind requireRealAuth (session-only), since an API key that
// could mint or revoke other API keys would let a single leaked key
// compromise the whole account rather than just music generation.
import { Request, Response, NextFunction } from 'express';
import { extractBearerToken, verifyAuthTokenRemote } from '../lib/auth.js';
import { validateMusicApiKey, MUSIC_API_KEY_PREFIX } from '../lib/musicApiKeys.js';
import { logger } from '../lib/logger.js';

const authLogger = logger.child({ module: 'music-auth' });

export interface MusicAuthedRequest extends Request {
  userId?: string;
}

export async function requireMusicAuth(
  req: MusicAuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  let token: string;
  try {
    token = extractBearerToken(req.headers.authorization);
  } catch {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }

  if (token.startsWith(MUSIC_API_KEY_PREFIX)) {
    try {
      const userId = await validateMusicApiKey(token);
      if (!userId) {
        res.status(401).json({ error: 'Invalid or revoked API key.' });
        return;
      }
      req.userId = userId;
      next();
    } catch (err) {
      authLogger.error({ err }, 'API key validation failed');
      res.status(401).json({ error: 'Invalid or revoked API key.' });
    }
    return;
  }

  try {
    const { userId } = await verifyAuthTokenRemote(token);
    req.userId = userId;
    next();
  } catch (err) {
    authLogger.debug({ err }, 'requireMusicAuth rejected request');
    res.status(401).json({ error: 'Sign in required.' });
  }
}
