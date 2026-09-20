// Wires the voice studio router (routes/voiceStudioRouter.ts) to real dependencies. Mounted at
// /api/voice-studio (NOT /api/voices, which is the existing text-to-speech voice catalogue).
import { config } from '../lib/config.js';
import { verifyAuthTokenRemote, extractBearerToken } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import { createIntakeClient } from '../lib/voiceIntakeClient.js';
import { listApiKeysForUser } from '../lib/ttsApiKeys.js';
import { setGatewayKeyOwner } from '../lib/ttsGatewayClient.js';
import { createVoiceStudioRouter } from './voiceStudioRouter.js';

const log = logger.child({ module: 'voiceStudio' });

export const voiceStudioRouter = createVoiceStudioRouter({
  // Real Supabase JWT only (same as ttsApiKeys.ts): requireAuth's default-user fallback must not apply here.
  authenticate: async (req) => {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) return null;
    return (await verifyAuthTokenRemote(token)).userId;
  },
  intake: createIntakeClient(config.VOICE_INTAKE_URL, config.INTAKE_SECRET),
  enabledUsers: () => config.VOICE_STUDIO_ENABLED_USERS,
  maxVoicesPerUser: config.VOICE_STUDIO_MAX_VOICES_PER_USER,
  maxZipBytes: config.VOICE_STUDIO_MAX_ZIP_MB * 1024 * 1024,
  backfillKeyOwners: async (userId) => {
    const keys = await listApiKeysForUser(userId);
    await Promise.all(keys.filter((k) => !k.revoked_at).map((k) => setGatewayKeyOwner(k.gateway_key_id, userId)));
  },
  log,
});
