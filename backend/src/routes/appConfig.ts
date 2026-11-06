import { Router, Request, Response } from 'express';
import { getPaywallMode, getPaywallTuning } from '../lib/paywallConfig.js';
import { getTtsFlags } from '../lib/ttsFlags.js';

export const appConfigRouter = Router();

/**
 * GET /api/config
 * Public endpoint — returns app-level configuration flags.
 * No auth required so the app can fetch this before login.
 */
appConfigRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    paywallMode: getPaywallMode(),
    paywall: getPaywallTuning(),
    // Read by the Android TtsSourceFlags (refreshed every 6 h). engineApiEnabled is a kill switch only: always
    // false unless TTS_ENGINE_API_ENABLED=true is set explicitly (see lib/ttsFlags.ts).
    tts: getTtsFlags(),
  });
});
