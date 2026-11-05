// API-key front door for consent-gated voice cloning (Chatterbox, Perth-watermarked output), mounted at
// /internal/voice-clone-api. Not directly customer facing: reachable only from a trusted forwarder that has
// already validated the caller's API key (the readaloud-web REST + MCP layer today, the realtime-tts gateway
// if it ever proxies /v1/voice-clones) and sends the shared secret plus the resolved identity. Same trust
// model as routes/voiceStudioApiKey.ts; see lib/voiceCloning/apiKeyIdentity.ts and MCP_AUTH_BRIDGE.md.
//
// Nothing about cloning is reimplemented here. The create / consent / list / delete behaviour is the existing
// createVoiceClonesRouter (routes/voiceClones.ts) mounted with a different identity resolver, so every gate
// the website flow has applies unchanged: verified email, paid or complimentary plan, daily limit, reference
// quality gate, strict consent (server-issued phrase + ASR + speaker similarity) or attestation mode exactly as
// VOICE_CLONE_REQUIRE_CONSENT_PHRASE says, in-flight guard, watermark, deletion and retention rules. This file
// only adds what an API caller needs on top:
//
//   POST   /consent-phrase     issue the single-use phrase to read aloud (alias of /consent-challenges)
//   GET    /config             { consent_required }
//   POST   /                   multipart: challenge_id, name, language, consent (audio), reference (audio)
//                              attestation mode: name, language, reference, attested="true"
//   GET    /                   list the caller's own cloned voices
//   DELETE /:id                delete reference audio, embeddings, cached prompts
//   POST   /:id/speech         { text, speed? } -> audio/wav, only for the voice's owner
//
// Own-voice only: there is no endpoint that clones without the consent recording from the same speaker
// (strict mode), and every voice is bound to the account behind the key. A key with no bound account cannot
// clone (403 account_required). Audio and keys are never logged.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { supabase } from '../lib/supabaseClient.js';
import { synthesizeWithClone, type CloneDeps } from '../lib/voiceCloning/service.js';
import { getCloneDeps, planForUser } from '../lib/voiceCloning/runtime.js';
import { resolveApiKeyIdentity, type ApiKeyIdentityDeps } from '../lib/voiceCloning/apiKeyIdentity.js';
import type { Eligibility } from '../lib/voiceCloning/types.js';
import { createVoiceClonesRouter, sendError } from './voiceClones.js';

const log = logger.child({ module: 'voiceCloneApiKey' });

export const SPEECH_MAX_CHARS = 1500;

export interface VoiceCloneApiDeps {
  /** null = feature dark (VOICE_CLONE_SERVICE_URL / secret / STT_API_KEY not configured). */
  getDeps: () => CloneDeps | null;
  identity: ApiKeyIdentityDeps;
  /** Operator kill switch for this API surface only (the website flow is unaffected). */
  disabled?: () => boolean;
  /** Per-account hourly caps. Tighter than the website's burst limiter: a script can go far faster than a person. */
  rateLimits?: { create?: number; speech?: number };
}

type ApiReq = Request & { apiEligibility?: Eligibility };

const speechSchema = z.object({
  text: z.string().min(1).max(SPEECH_MAX_CHARS),
  speed: z.number().min(0.5).max(3).default(1),
});
const uuid = z.string().uuid();

export function createVoiceCloneApiRouter(d: VoiceCloneApiDeps): Router {
  const r = Router();
  const lim = { create: 5, speech: 60, ...d.rateLimits };
  const limiter = (name: string, max: number) =>
    rateLimit({
      windowMs: 3600_000, max, standardHeaders: true, legacyHeaders: false, validate: false,
      keyGenerator: (req) => `voice-clone-api-${name}:${(req as ApiReq).apiEligibility?.userId ?? req.ip}`,
      message: { error: 'Too many requests. Try again later.', code: 'rate_limited' },
    });

  // 1. Who is calling (shared secret + resolved identity). Before anything else, so an unauthenticated caller learns nothing.
  r.use((req: Request, res: Response, next: NextFunction) => {
    resolveApiKeyIdentity(req, d.identity).then((id) => {
      if (id.kind === 'eligibility') { (req as ApiReq).apiEligibility = id.eligibility; next(); return; }
      if (id.kind === 'account_required') {
        res.status(403).json({ error: 'Voice cloning needs an API key that belongs to a ReadAloud account. Create a key while signed in at https://readaloudai.org/developers#get-started.', code: 'account_required' });
      } else if (id.kind === 'unavailable') {
        res.status(503).json({ error: 'Voice cloning is temporarily unavailable. Try again later.', code: 'service_unavailable' });
      } else {
        res.status(401).json({ error: 'Invalid or missing API key.', code: 'unauthenticated' });
      }
    }).catch((err) => sendError(res, err));
  });

  // 2. Feature switches.
  r.use((_req, res, next) => {
    if (d.disabled?.() || !d.getDeps()) { res.status(503).json({ error: 'Voice cloning is not available.', code: 'unavailable' }); return; }
    next();
  });

  // 3. Public name for "issue a consent phrase"; the shared router calls it /consent-challenges.
  r.post('/consent-phrase', (req, _res, next) => { req.url = '/consent-challenges'; next(); });

  r.post('/', limiter('create', lim.create));

  r.post('/:id/speech', limiter('speech', lim.speech), express.json({ limit: '16kb' }), (req: Request, res: Response) => {
    (async () => {
      const id = uuid.safeParse(req.params.id);
      const body = speechSchema.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: `Send JSON { "text": 1-${SPEECH_MAX_CHARS} characters, "speed": 0.5-3 (optional) } to a valid voice id.`, code: 'validation' });
        return;
      }
      const e = (req as ApiReq).apiEligibility!;
      // Owner-only: getUsableVoice looks the voice up by (id, caller). Another account's voice is a plain 404.
      const { voice, synth, ms } = await synthesizeWithClone(d.getDeps()!, { eligibility: e, voiceId: id.data, text: body.data.text, speed: body.data.speed });
      log.info({ event: 'voice_clone_speech', channel: 'api', userId: e.userId, voiceId: voice.id, chars: body.data.text.length, ms }, 'cloned voice synthesis');
      res.set({
        'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Voice-ID': voice.id, 'X-Model': synth.modelId,
        'X-Watermark': synth.watermarkScheme, 'X-Characters-Used': String(body.data.text.length), 'X-Synthesis-Time-Ms': String(ms),
      }).send(synth.audio);
    })().catch((err) => sendError(res, err));
  });

  // 4. Everything else (config, consent challenge, create, list, delete) is the existing router, unchanged.
  r.use(createVoiceClonesRouter({
    getDeps: d.getDeps,
    resolveEligibility: async (req) => (req as ApiReq).apiEligibility ?? null,
    channel: 'api',
    abuseReports: false,
  }));
  return r;
}

export const voiceCloneApiKeyRouter = createVoiceCloneApiRouter({
  getDeps: () => getCloneDeps(),
  identity: {
    forwardSecret: () => config.GATEWAY_FORWARD_SECRET,
    getUser: async (uid) => {
      const { data, error } = await supabase.auth.admin.getUserById(uid);
      if (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
      return data?.user ? { emailVerified: !!data.user.email_confirmed_at } : null;
    },
    planFor: planForUser,
  },
  // Exactly "true" turns the API surface off without touching the website flow (the owner's existing kill-switch style).
  disabled: () => process.env.VOICE_CLONE_API_DISABLED === 'true',
});
