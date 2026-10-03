import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';

import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

import { requireAuth } from './middleware/auth.js';
import { requireAuthOrApiKey } from './middleware/apiKeyAuth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { reportFailure, reportCrash } from './lib/failureReporter.js';
import { standardRateLimit, ttsRateLimitByTier, previewRateLimit, burstRateLimit, jobPollingRateLimit, realtimeTtsAuthorizeRateLimit } from './middleware/rateLimit.js';

import { ttsRouter } from './routes/tts.js';
import { realtimeTtsRouter } from './routes/realtimeTts.js';
import { usageRouter } from './routes/usage.js';
import { voicesRouter } from './routes/voices.js';
import { extractRouter } from './routes/extract.js';
import { audioRouter } from './routes/audio.js';
import { subscriptionRouter } from './routes/subscription.js';
import { latencyRouter } from './routes/latency.js';
import { aiRouter } from './routes/ai.js';
import { adminRouter } from './routes/admin.js';
import { workerPushRouter } from './routes/workerPush.js';
import { clonedVoicesRouter } from './routes/clonedVoices.js';
import { storiesRouter } from './routes/stories.js';
import { audiobooksRouter } from './routes/audiobooks.js';
import { voiceMarketplaceRouter } from './routes/voiceMarketplace.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { authRouter } from './routes/auth.js';
import { appConfigRouter } from './routes/appConfig.js';
import { ttsApiKeysRouter, requireRealAuth } from './routes/ttsApiKeys.js';
import { textToMusicRouter } from './routes/textToMusic.js';
import { musicApiKeysRouter } from './routes/musicApiKeys.js';
import { requireMusicAuth } from './middleware/musicAuth.js';
import { voiceStudioRouter } from './routes/voiceStudio.js';
import { voiceDesignRouter } from './routes/voiceDesign.js';
import { voiceConvertRouter } from './routes/voiceConvert.js';
import { voiceIsolateRouter } from './routes/voiceIsolate.js';
// XTTS v2 voice cloning removed: non-commercial license, see takedown/xtts-voice-cloning branch.
// import { voiceCloneRouter } from './routes/voiceClone.js';
import { sttRouter } from './routes/stt.js';
import { voiceStudioApiKeyRouter } from './routes/voiceStudioApiKey.js';
import { orpheusVoiceStudioApiKeyRouter } from './routes/orpheusVoiceStudioApiKey.js';
import { orpheusVoiceStudioRouter } from './routes/orpheusVoiceStudio.js';
import { dubRouter } from './routes/dub.js';
import { soundEffectsRouter } from './routes/soundEffects.js';
import { aggregateLatencyMetrics, checkSupabaseHealth, checkStorageHealth } from './lib/supabaseClient.js';
import { startWorker, stopWorker } from './workers/ttsJobWorker.js';
import { startSoundEffectJobWorker, stopSoundEffectJobWorker } from './workers/soundEffectJobWorker.js';
import { startMusicJobWorker, stopMusicJobWorker } from './workers/musicJobWorker.js';
import { checkPubSubHealth } from './lib/pubsub.js';
import { initRolloutFromEnv } from './lib/rollout.js';
import { reportUsageToStripe } from './lib/realtimeTtsBilling.js';

// Initialize rollout configuration from environment
initRolloutFromEnv();

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();

// ============================================================================
// Global Middleware
// ============================================================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API
}));

// CORS
// Was a literal unfixed placeholder ('your-app-domain.com') until now - meant every
// browser (not native-app) cross-origin call from the real web app was being CORS-
// blocked in production. Native app traffic (iOS) isn't subject to CORS at all, which
// is almost certainly why this went unnoticed.
app.use(cors({
  origin: config.NODE_ENV === 'production'
    ? ['https://readaloudai.org', 'https://readaloud-web.fly.dev']
    : true,
  credentials: true,
  exposedHeaders: [
    'X-Characters-Used',
    'X-Audio-Duration-Ms',
    'X-Daily-Used',
    'X-Daily-Limit',
    'X-Monthly-Used',
    'X-Monthly-Limit',
  ],
}));

// Compression
app.use(compression());

// Stripe webhook needs raw body for signature verification
// Must be before express.json() middleware
app.use('/api/webhooks', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// Body parsing
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health',
  },
  redact: ['req.headers.authorization'],
}));

// Trust proxy (required for rate limiting behind load balancer)
app.set('trust proxy', 1);

// ============================================================================
// Health Check (Unauthenticated)
// ============================================================================

app.get('/health', async (_req, res) => {
  // Basic health check
  const basicHealth = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
  };

  // If ?detailed=true, include connectivity checks
  if (_req.query.detailed === 'true') {
    try {
      const [supabaseHealth, storageHealth, pubsubHealth] = await Promise.all([
        checkSupabaseHealth(),
        checkStorageHealth(),
        checkPubSubHealth(),
      ]);

      res.json({
        ...basicHealth,
        services: {
          supabase: {
            connected: supabaseHealth.connected,
            latencyMs: supabaseHealth.latencyMs,
            recentErrors: supabaseHealth.diagnostics.errorRate,
            error: supabaseHealth.error,
          },
          storage: {
            connected: storageHealth.connected,
            latencyMs: storageHealth.latencyMs,
            error: storageHealth.error,
          },
          pubsub: {
            connected: pubsubHealth,
          },
        },
      });
    } catch (error) {
      res.json({
        ...basicHealth,
        servicesError: error instanceof Error ? error.message : 'Unknown error',
      });
    }
    return;
  }

  res.json(basicHealth);
});

// ============================================================================
// API Routes
// ============================================================================

// Standard rate limiting for all API routes (applied first, then overridden by specific routes)
app.use('/api', standardRateLimit);

// Job status polling endpoint - uses generous rate limit (60 req/min)
// This is a GET-only route that skips TTS tier rate limiting
app.get('/api/tts/job/:jobId', jobPollingRateLimit, requireAuth, ttsRouter);

// Job cancel endpoint - uses same generous rate limit as polling (it's a cleanup operation)
app.post('/api/tts/job/:jobId/cancel', jobPollingRateLimit, requireAuth, ttsRouter);

// TTS routes with tier-based rate limiting (excludes job polling which is handled above)
// Order: burstRateLimit (spam prevention) → requireAuth → ttsRateLimitByTier (tier-aware) → ttsRouter
// Note: Job routes are handled by specific routes above, this catches the rest
app.use('/api/tts', burstRateLimit, requireAuth, ttsRateLimitByTier, ttsRouter);

// realtime-tts authorize proxy: holds the dedicated REALTIME_TTS_API_KEY server-side and forwards
// authorize calls to the realtime-tts platform, so the Android app never sees the raw platform key.
//
// This route is intentionally callable without real per-user auth (requireAuth defaults callers with
// no/invalid token to a shared "pro user" rather than rejecting them, matching this app's existing
// generous-free-tier philosophy elsewhere). Since every successful call here mints a session billed
// against the shared REALTIME_TTS_API_KEY, it is bounded by realtimeTtsAuthorizeRateLimit (IP-keyed,
// stricter than the general-purpose burstRateLimit) in addition to burstRateLimit. This must be
// revisited before any public (non-invite-only) launch — see middleware/rateLimit.ts for details.
app.use('/api/realtime-tts', burstRateLimit, realtimeTtsAuthorizeRateLimit, requireAuth, realtimeTtsRouter);

// Preview endpoint has stricter rate limit (10 req/min)
app.use('/api/tts/preview', previewRateLimit);

// Text-to-music job routes: billable, external-facing, so requireMusicAuth
// (accepts a persistent API key OR a session token — no permissive
// default-user fallback either way) rather than requireAuth. Job polling
// gets the generous polling rate limit, same pattern as /api/tts/job/:jobId
// above.
app.get('/api/music/job/:jobId', jobPollingRateLimit, requireMusicAuth, textToMusicRouter);
app.use('/api/music', burstRateLimit, requireMusicAuth, textToMusicRouter);

// Music API key management: session-only (requireRealAuth) — minting/
// revoking keys must never be doable with just an API key, or a leaked key
// could mint infinite new ones.
app.use('/api/music-api-keys', requireRealAuth, musicApiKeysRouter);

// Usage routes (requires auth)
app.use('/api/usage', requireAuth, usageRouter);

// Voices routes (public - no auth for listing, auth for /full endpoint)
// Note: /voices is public, /voices/full requires auth (handled in router)
app.use('/api/voices', voicesRouter);

// Extract routes (requires auth) - for URL content extraction
app.use('/api/extract', requireAuth, extractRouter);

// Audio storage routes (requires auth) - for cloud audio backup/restore
app.use('/api/audio', audioRouter);

// Subscription routes (requires auth) - for syncing App Store purchases
app.use('/api/subscription', requireAuth, subscriptionRouter);

// Latency tracking routes - estimate is public, report requires auth
app.use('/api/latency', latencyRouter);

// AI routes (requires auth) - for article summarization and analysis
app.use('/api/ai', requireAuth, aiRouter);

// Admin routes (requires admin API key) - for rollout control and metrics
app.use('/api/admin', adminRouter);

// Pub/Sub push worker endpoint (auth via ?token= query param)
app.use('/api/tts', workerPushRouter);

// Cloned voices routes (requires auth) - for voice cloning with Chatterbox
app.use('/api/cloned-voices', clonedVoicesRouter);

// Story generation (Lullaby Haven custom bedtime stories) — X-Device-ID gated,
// per-device rate limit set inside the router.
app.use('/api/stories', storiesRouter);

// Audiobooks MVP (requires auth, or a gateway-forwarded MCP API key identity —
// see middleware/apiKeyAuth.ts) — chapter detection + batch same-voice TTS
// per chapter + ffmpeg MP3 export with chapter markers. Backend/API only.
app.use('/api/audiobooks', requireAuthOrApiKey, audiobooksRouter);

// TTS realtime API key management (requires a REAL Supabase JWT, not the
// requireAuth default-user fallback — see routes/ttsApiKeys.ts).
app.use('/api/tts-api-keys', ttsApiKeysRouter);

// Voice design — Parler-TTS text-to-voice generation (dark unless VOICE_DESIGN_URL is configured).
// requireAuthOrApiKey: accepts a real Supabase JWT (web) or a gateway-forwarded API-key identity (MCP);
// the router's requireUser() still enforces the active-subscription check for both. See MCP_AUTH_BRIDGE.md.
app.use('/api/voice-design', requireAuthOrApiKey, voiceDesignRouter);
// Voice convert — Seed-VC speech-to-speech voice conversion (dark unless VOICE_CONVERT_URL is configured).
// Same bridge as voice-design. API-key callers have no browser to click "Deploy": POST /deploy is itself
// bridged, and a 400 with code 'deployment_required' tells them to call it (the MCP convert_voice tool does).
app.use('/api/voice-convert', requireAuthOrApiKey, voiceConvertRouter);
// Voice isolate — Demucs (htdemucs) vocal isolation (dark unless VOICE_ISOLATE_URL is configured).
// requireAuthOrApiKey lets the MCP tool call in with a gateway-forwarded API key identity, same as
// stt.ts; the route's own requireUser()/requireUserMiddleware already checks req.userId first (set by
// requireAuthOrApiKey) before falling back to JWT verification, so no changes were needed inside
// voiceIsolate.ts itself — see MCP_AUTH_BRIDGE.md.
app.use('/api/voice-isolate', requireAuthOrApiKey, voiceIsolateRouter);
// Voice clone — XTTS v2 instant voice cloning removed (non-commercial license).
// app.use('/api/voice-clone', voiceCloneRouter);
app.use('/api/stt', requireAuthOrApiKey, sttRouter);
// Dubbing v1 — audio-in/audio-out re-voicing via STT (external worker-stt-prod) + Claude
// translation + existing TTS pipeline (dark unless STT_WORKER_URL is configured). See
// routes/dub.ts header for scope boundaries (no video, in-memory jobs only).
app.use('/api/dub', requireAuthOrApiKey, dubRouter);
// Sound effects — text-to-sound-effect generation on a shared Modal worker (see
// backend/modal/sound_effects_worker.py), async job API mirroring the
// text-to-music feature's textToMusic.ts. Dark unless SOUND_EFFECTS_WORKER_URL
// is configured (soundEffects.ts's routes still respond, but jobs never leave 'queued'
// without the worker below actually running — mirrors MUSIC_WORKER_ENABLED's gating).
// Uses requireAuthOrApiKey (not requireAuth): this is a billed, MCP-reachable route, and
// requireAuth's default-user fallback would let an unauthenticated/invalid caller get
// billed to a shared default user. requireAuthOrApiKey has no such fallback — it accepts
// either a real Supabase JWT or a gateway-forwarded API-key identity, and rejects (401)
// anything else. See MCP_AUTH_BRIDGE.md.
// Hidden by default: measured cold-start cost exceeds the price (docs/MONEY_PATH_COSTS.md) and the
// worker app is not deployed. Set SOUND_EFFECTS_PUBLIC=true to re-enable (also needs the MCP/web flag).
app.use('/api/sound-effects', (_req, res, next) => {
  if (process.env.SOUND_EFFECTS_PUBLIC === 'true') return next();
  res.status(503).json({ error: 'Sound effects are temporarily unavailable.' });
}, requireAuthOrApiKey, soundEffectsRouter);
// strict Supabase auth like the API-key routes above.
app.use('/api/voice-studio', voiceStudioRouter);

// Same voice-studio logic via an API key instead of a Supabase session, reachable only from the gateway
// (realtime-tts-gateway proxies /v1/voices here after validating the key) — see routes/voiceStudioApiKey.ts.
// Not behind requireAuth/standardRateLimit: it does its own shared-secret check and its own rate limiting.
app.use('/internal/voice-studio-api', voiceStudioApiKeyRouter);

// Orpheus streaming voice cloning: same gateway-trusted pattern as voice-studio-api above, but a plain
// direct router (no createVoiceStudioRouter factory) proxying to the Modal training/serving service.
// See routes/orpheusVoiceStudioApiKey.ts.
app.use('/internal/orpheus-clone-api', orpheusVoiceStudioApiKeyRouter);

// Same Orpheus cloning operations, but for real logged-in customers via their Supabase session (not the
// gateway shared secret above) — powers the web UI at web/src/components/ra/OrpheusVoiceStudio.tsx. See
// routes/orpheusVoiceStudio.ts for why this is a separate file rather than reusing the gateway-trusted one.
app.use('/api/orpheus-voice-studio', orpheusVoiceStudioRouter);

// Voice marketplace routes - for sharing and discovering cloned voices
app.use('/api/marketplace', voiceMarketplaceRouter);

// Auth routes - for Apple/Google sign-in (no auth middleware - handles its own auth)
app.use('/api/auth', authRouter);

// App config - public, no auth required (paywall mode, feature flags)
app.use('/api/config', appConfigRouter);

// ============================================================================
// Error Handling
// ============================================================================

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// ============================================================================
// Server Startup
// ============================================================================

const PORT = config.PORT;

// Fail fast and loud BEFORE the server starts accepting traffic, rather than
// inside the app.listen() callback: a misconfiguration caught only after the
// port is already bound would crash the whole process (taking down TTS,
// Stripe webhooks, everything) instead of cleanly failing the deploy.
// MUSIC_WORKER_ENABLED=true with no URL configured is always a
// misconfiguration, never an intentional state — every queued music job
// would silently fail otherwise.
if (process.env.MUSIC_WORKER_ENABLED === 'true' && !process.env.MUSIC_WORKER_URL) {
  throw new Error(
    'MUSIC_WORKER_ENABLED=true but MUSIC_WORKER_URL is not set — refusing to start the music job worker against an empty URL. Set MUSIC_WORKER_URL (and MUSIC_WORKER_SHARED_SECRET) or unset MUSIC_WORKER_ENABLED.'
  );
}

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, env: config.NODE_ENV }, 'Server started');

  // Run latency aggregation on startup (after short delay) and every 6 hours
  // This is best-effort - fine if Cloud Run scales down and misses some runs
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  setTimeout(() => {
    aggregateLatencyMetrics().catch(err => {
      logger.warn({ err }, 'Initial latency aggregation failed (non-critical)');
    });
  }, 30_000); // Wait 30s after startup

  setInterval(() => {
    aggregateLatencyMetrics().catch(err => {
      logger.warn({ err }, 'Periodic latency aggregation failed (non-critical)');
    });
  }, SIX_HOURS_MS);

  // Drains the realtime-tts gateway's per-key character usage and reports it
  // to Stripe as meter events — see lib/realtimeTtsBilling.ts. Frequent
  // (5min) since the gateway's own counters reset on each drain; a longer
  // interval just means a bigger loss window if a report call fails.
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  setInterval(() => {
    reportUsageToStripe().catch(err => {
      logger.warn({ err }, 'Periodic realtime-tts usage report failed (non-critical)');
    });
  }, FIVE_MINUTES_MS);

  // Pull-based worker disabled — jobs are now delivered via Pub/Sub push
  // to /api/tts/worker/push. Set TTS_WORKER_ENABLED=true only for local dev.
  if (process.env.TTS_WORKER_ENABLED === 'true') {
    logger.info('Starting embedded TTS pull worker (dev mode)');
    startWorker({
      maxRetries: parseInt(process.env.WORKER_MAX_RETRIES ?? '3', 10),
      enabled: true,
    });
  }

  // Embedded polling worker for sound effect generation jobs — mirrors the
  // music worker's MUSIC_WORKER_ENABLED gate below. Off by
  // default: a deploy with no Modal worker provisioned should not spin up
  // a poll loop that will just fail every callModalWorker() call.
  if (process.env.SOUND_EFFECT_WORKER_ENABLED === 'true') {
    logger.info('Starting sound effect job worker');
    startSoundEffectJobWorker();
  }

  // Music job worker polling loop — calls the Modal music-generation endpoint
  // every 3s and reaps jobs stuck in 'processing'. Unlike the TTS worker
  // above (which is genuinely dev-only, since production TTS is delivered
  // via Pub/Sub push), the music job worker is the ONLY delivery mechanism
  // for music jobs — there is no push-based alternative — so
  // MUSIC_WORKER_ENABLED=true must be set in production too, or music jobs
  // will queue forever and never be processed. See cloudbuild.yaml.
  if (process.env.MUSIC_WORKER_ENABLED === 'true') {
    logger.info('Starting music job worker');
    startMusicJobWorker();
  }
});

// Graceful shutdown
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop worker if running
  if (process.env.TTS_WORKER_ENABLED === 'true') {
    stopWorker();
  }
  if (process.env.SOUND_EFFECT_WORKER_ENABLED === 'true') {
    stopSoundEffectJobWorker();
  }
  if (process.env.MUSIC_WORKER_ENABLED === 'true') {
    stopMusicJobWorker();
  }

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled rejection handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
  reportFailure('unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  reportCrash('uncaughtException', error).finally(() => process.exit(1));
});

export default app;
