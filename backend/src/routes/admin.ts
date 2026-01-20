import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { createWriteStream, existsSync, statSync, unlinkSync } from 'fs';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getRolloutStatus,
  setRolloutPercent,
  enableKillSwitch,
  disableKillSwitch,
  addToAllowlist,
  removeFromAllowlist,
  addToBlocklist,
  removeFromBlocklist,
  isUserInJobApiRollout,
} from '../lib/rollout.js';
import {
  getFailureStats,
  getInferenceLatencyStats,
} from '../lib/metrics.js';
import {
  getElevenLabsClient,
  isElevenLabsConfigured,
  type TTFBMetrics,
} from '../lib/elevenLabsClient.js';
import type { AuthenticatedRequest } from '../types/index.js';

// ============================================================================
// Admin Logger
// ============================================================================

const adminLogger = logger.child({ module: 'admin' });

// ============================================================================
// Admin API Key Check
// ============================================================================

// Simple API key check for admin endpoints
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'listenai-admin-key-change-me';

function requireAdminAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const apiKey = req.headers['x-admin-key'] as string;

  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    adminLogger.warn({ ip: req.ip }, 'Unauthorized admin access attempt');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

// ============================================================================
// Async Handler Wrapper
// ============================================================================

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const adminRouter = Router();

// All admin routes require API key
adminRouter.use(requireAdminAuth);

// ============================================================================
// GET /admin/rollout - Get rollout status
// ============================================================================

adminRouter.get('/rollout', (_req: Request, res: Response) => {
  const status = getRolloutStatus();
  res.json(status);
});

// ============================================================================
// POST /admin/rollout/percent - Set rollout percentage
// ============================================================================

adminRouter.post('/rollout/percent', (req: Request, res: Response) => {
  const { percent } = req.body;

  if (typeof percent !== 'number' || percent < 0 || percent > 100) {
    res.status(400).json({ error: 'Percent must be a number between 0 and 100' });
    return;
  }

  setRolloutPercent(percent);
  adminLogger.info({ percent }, 'Rollout percentage updated');

  res.json({
    success: true,
    message: `Rollout percentage set to ${percent}%`,
    status: getRolloutStatus(),
  });
});

// ============================================================================
// POST /admin/rollout/kill-switch - Toggle kill switch
// ============================================================================

adminRouter.post('/rollout/kill-switch', (req: Request, res: Response) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }

  if (enabled) {
    enableKillSwitch();
    adminLogger.warn('Kill switch ENABLED - new pipeline disabled for all users');
  } else {
    disableKillSwitch();
    adminLogger.info('Kill switch disabled - rollout resumed');
  }

  res.json({
    success: true,
    message: enabled ? 'Kill switch enabled' : 'Kill switch disabled',
    status: getRolloutStatus(),
  });
});

// ============================================================================
// POST /admin/rollout/allowlist - Manage allowlist
// ============================================================================

adminRouter.post('/rollout/allowlist', (req: Request, res: Response) => {
  const { action, userId } = req.body;

  if (!userId || typeof userId !== 'string') {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  if (action === 'add') {
    addToAllowlist(userId);
    adminLogger.info({ userId }, 'User added to allowlist');
    res.json({ success: true, message: `User ${userId} added to allowlist` });
  } else if (action === 'remove') {
    removeFromAllowlist(userId);
    adminLogger.info({ userId }, 'User removed from allowlist');
    res.json({ success: true, message: `User ${userId} removed from allowlist` });
  } else {
    res.status(400).json({ error: 'action must be "add" or "remove"' });
  }
});

// ============================================================================
// POST /admin/rollout/blocklist - Manage blocklist
// ============================================================================

adminRouter.post('/rollout/blocklist', (req: Request, res: Response) => {
  const { action, userId } = req.body;

  if (!userId || typeof userId !== 'string') {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  if (action === 'add') {
    addToBlocklist(userId);
    adminLogger.info({ userId }, 'User added to blocklist');
    res.json({ success: true, message: `User ${userId} added to blocklist` });
  } else if (action === 'remove') {
    removeFromBlocklist(userId);
    adminLogger.info({ userId }, 'User removed from blocklist');
    res.json({ success: true, message: `User ${userId} removed from blocklist` });
  } else {
    res.status(400).json({ error: 'action must be "add" or "remove"' });
  }
});

// ============================================================================
// GET /admin/rollout/check/:userId - Check if user is in rollout
// ============================================================================

adminRouter.get('/rollout/check/:userId', (req: Request, res: Response) => {
  const userId = req.params.userId;

  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }

  const inRollout = isUserInJobApiRollout(userId);

  res.json({
    userId,
    inRollout,
    status: getRolloutStatus(),
  });
});

// ============================================================================
// GET /admin/metrics - Get observability metrics
// ============================================================================

adminRouter.get('/metrics', (_req: Request, res: Response) => {
  const failureStats = getFailureStats();
  const latencyStats = getInferenceLatencyStats();

  res.json({
    timestamp: new Date().toISOString(),
    failure_stats: failureStats,
    latency_stats: latencyStats,
    rollout_status: getRolloutStatus(),
  });
});

// ============================================================================
// GET /admin/metrics/failures - Get failure rates
// ============================================================================

adminRouter.get('/metrics/failures', (_req: Request, res: Response) => {
  const failureStats = getFailureStats();
  res.json(failureStats);
});

// ============================================================================
// GET /admin/metrics/latency - Get inference latency stats
// ============================================================================

adminRouter.get('/metrics/latency', (_req: Request, res: Response) => {
  const latencyStats = getInferenceLatencyStats();
  res.json(latencyStats);
});

// ============================================================================
// POST /admin/test-tts-elevenlabs - Test ElevenLabs TTS Integration
// ============================================================================

interface TestTTSRequest {
  text?: string;
  voice_id?: string;
}

interface TestTTSResponse {
  success: boolean;
  provider: string;
  configured: boolean;
  duration_ms: number;
  bytes_written: number;
  file_path: string;
  metrics: TTFBMetrics | null;
  error?: string;
}

adminRouter.post(
  '/test-tts-elevenlabs',
  asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const body = req.body as TestTTSRequest;

    // Default test text and voice
    const testText = body.text || 'Hello, this is a test of the ElevenLabs text to speech integration. The audio should sound natural and clear.';
    const voiceId = body.voice_id || 'af_sarah'; // Sarah - clear female voice

    adminLogger.info({
      textLength: testText.length,
      voiceId,
    }, 'Starting ElevenLabs TTS test');

    // Check if ElevenLabs is configured
    if (!isElevenLabsConfigured()) {
      const response: TestTTSResponse = {
        success: false,
        provider: 'elevenlabs',
        configured: false,
        duration_ms: Date.now() - startTime,
        bytes_written: 0,
        file_path: '',
        metrics: null,
        error: 'ELEVENLABS_API_KEY not configured',
      };
      res.status(400).json(response);
      return;
    }

    const client = getElevenLabsClient();
    if (!client) {
      const response: TestTTSResponse = {
        success: false,
        provider: 'elevenlabs',
        configured: true,
        duration_ms: Date.now() - startTime,
        bytes_written: 0,
        file_path: '',
        metrics: null,
        error: 'Failed to initialize ElevenLabs client',
      };
      res.status(500).json(response);
      return;
    }

    // Test file path
    const testFilePath = '/tmp/test-elevenlabs.mp3';

    try {
      // Clean up any existing test file
      if (existsSync(testFilePath)) {
        unlinkSync(testFilePath);
      }

      // Use synthesizeToFile which streams directly without buffering
      const result = await client.synthesizeToFile(
        {
          text: testText,
          voiceId,
        },
        testFilePath
      );

      // Verify file was written
      const fileStats = existsSync(testFilePath) ? statSync(testFilePath) : null;
      const bytesWritten = fileStats?.size || result.bytesWritten;

      adminLogger.info({
        bytesWritten,
        metrics: result.metrics,
        filePath: testFilePath,
      }, 'ElevenLabs TTS test completed');

      const response: TestTTSResponse = {
        success: true,
        provider: 'elevenlabs',
        configured: true,
        duration_ms: Date.now() - startTime,
        bytes_written: bytesWritten,
        file_path: testFilePath,
        metrics: result.metrics,
      };

      // Log TTFB details for verification
      adminLogger.info({
        t_start: result.metrics.t_start,
        t_first_byte: result.metrics.t_first_byte,
        t_done: result.metrics.t_done,
        ttfb_ms: result.metrics.ttfb_ms,
        total_ms: result.metrics.total_ms,
      }, 'ElevenLabs TTFB metrics');

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      adminLogger.error({
        error: errorMessage,
        voiceId,
        textLength: testText.length,
      }, 'ElevenLabs TTS test failed');

      const response: TestTTSResponse = {
        success: false,
        provider: 'elevenlabs',
        configured: true,
        duration_ms: Date.now() - startTime,
        bytes_written: 0,
        file_path: testFilePath,
        metrics: null,
        error: errorMessage,
      };

      res.status(500).json(response);
    }
  })
);

// ============================================================================
// GET /admin/test-tts-elevenlabs/status - Check ElevenLabs configuration status
// ============================================================================

adminRouter.get('/test-tts-elevenlabs/status', (_req: Request, res: Response) => {
  const configured = isElevenLabsConfigured();
  const client = configured ? getElevenLabsClient() : null;

  res.json({
    configured,
    available: client?.isAvailable() ?? false,
    provider: 'elevenlabs',
    env_var_set: !!process.env.ELEVENLABS_API_KEY,
    tts_provider_setting: process.env.TTS_PROVIDER || 'auto',
  });
});
