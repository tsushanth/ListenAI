// Features that can be switched off as a whole. A switched-off feature answers 503 with a plain "not available" message
// before any of its code runs: nothing calls its worker, nothing is billed, no row is written.
//
// OFF unless the env var is the literal string "true", so a deploy with nothing configured offers none of them:
//   VOICE_DESIGN_PUBLIC=true   voice design (/api/voice-design)
//   VOICE_STUDIO_PUBLIC=true   trained custom voices (/api/voice-studio, /internal/voice-studio-api and the streaming
//                              clone routes). The VOICE_STUDIO_ENABLED_* allowlists still apply on top.
// Turn one on only after its worker is deployed and one real call has been run, then set the matching flag in
// web/src/content/launchFlags.ts.
import type { Request, RequestHandler } from 'express';

export type SwitchableFeature = 'voice_design' | 'voice_studio';

const FEATURES: Record<SwitchableFeature, { env: string; message: string }> = {
  voice_design: { env: 'VOICE_DESIGN_PUBLIC', message: 'Voice design is not available right now.' },
  voice_studio: { env: 'VOICE_STUDIO_PUBLIC', message: 'Training a custom voice is not available right now.' },
};

export function featureOffered(feature: SwitchableFeature, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FEATURES[feature].env] === 'true';
}

export interface GateOptions {
  /** Requests that keep working while the feature is off (for example deleting stored data). */
  allow?: (req: Pick<Request, 'method' | 'path'>) => boolean;
  /** Answer GET / with an empty voice list, so a listing that merges these voices stays clean. */
  emptyListAtRoot?: boolean;
}

export function featureGate(feature: SwitchableFeature, options: GateOptions = {}, env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    if (featureOffered(feature, env) || options.allow?.(req)) return next();
    if (options.emptyListAtRoot && req.method === 'GET' && req.path === '/') { res.status(200).json({ voices: [] }); return; }
    res.locals.failureReported = true; // switched off on purpose, not a fault: keep the 5xx safety net quiet
    res.status(503).json({ error: FEATURES[feature].message, code: 'service_unavailable' });
  };
}

/** Saved voice descriptions can always be deleted. */
export const allowPresetDelete = (req: Pick<Request, 'method' | 'path'>): boolean => req.method === 'DELETE' && /^\/presets\/[^/]+$/.test(req.path);
