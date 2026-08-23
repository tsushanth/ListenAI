import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import pinoHttp from 'pino-http';

import { config } from './lib/config.js';
import { logger } from './lib/logger.js';

import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { standardRateLimit, ttsRateLimitByTier, previewRateLimit, burstRateLimit, jobPollingRateLimit } from './middleware/rateLimit.js';

import { ttsRouter } from './routes/tts.js';
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
import { voiceMarketplaceRouter } from './routes/voiceMarketplace.js';
import { stripeWebhookRouter } from './routes/stripeWebhook.js';
import { authRouter } from './routes/auth.js';
import { appConfigRouter } from './routes/appConfig.js';
import { ttsApiKeysRouter } from './routes/ttsApiKeys.js';
import { aggregateLatencyMetrics, checkSupabaseHealth, checkStorageHealth } from './lib/supabaseClient.js';
import { startWorker, stopWorker } from './workers/ttsJobWorker.js';
import { checkPubSubHealth } from './lib/pubsub.js';
import { initRolloutFromEnv } from './lib/rollout.js';

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

// Preview endpoint has stricter rate limit (10 req/min)
app.use('/api/tts/preview', previewRateLimit);

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

// TTS realtime API key management (requires a REAL Supabase JWT, not the
// requireAuth default-user fallback — see routes/ttsApiKeys.ts).
app.use('/api/tts-api-keys', ttsApiKeysRouter);


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

  // Pull-based worker disabled — jobs are now delivered via Pub/Sub push
  // to /api/tts/worker/push. Set TTS_WORKER_ENABLED=true only for local dev.
  if (process.env.TTS_WORKER_ENABLED === 'true') {
    logger.info('Starting embedded TTS pull worker (dev mode)');
    startWorker({
      maxRetries: parseInt(process.env.WORKER_MAX_RETRIES ?? '3', 10),
      enabled: true,
    });
  }
});

// Graceful shutdown
function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop worker if running
  if (process.env.TTS_WORKER_ENABLED === 'true') {
    stopWorker();
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
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

export default app;
