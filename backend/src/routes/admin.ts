import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { createWriteStream, existsSync, statSync, unlinkSync } from 'fs';
import crypto from 'crypto';
import { logger } from '../lib/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { supabase } from '../lib/supabaseClient.js';
import { processJobById } from '../workers/ttsJobWorker.js';
import { computeCacheKey } from '../lib/cacheKey.js';
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
import { getPaywallMode, setPaywallMode, type PaywallMode } from '../lib/paywallConfig.js';
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
import { ttsMetricsRouter } from './ttsMetrics.js';

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

// Mount /admin/tts-metrics — single-endpoint TTS pipeline dashboard.
// Inherits the x-admin-key auth from the parent router.
adminRouter.use('/tts-metrics', ttsMetricsRouter);

// ============================================================================
// GET /admin/paywall-mode - Get current paywall mode
// ============================================================================

adminRouter.get('/paywall-mode', (_req: Request, res: Response) => {
  res.json({ paywallMode: getPaywallMode() });
});

// ============================================================================
// POST /admin/paywall-mode - Set paywall mode ("soft" | "aggressive")
// ============================================================================

adminRouter.post('/paywall-mode', (req: Request, res: Response) => {
  const { mode } = req.body as { mode?: string };

  if (mode !== 'soft' && mode !== 'aggressive') {
    res.status(400).json({ error: 'mode must be "soft" or "aggressive"' });
    return;
  }

  setPaywallMode(mode as PaywallMode);
  adminLogger.info({ mode }, 'Paywall mode updated');
  res.json({ success: true, paywallMode: getPaywallMode() });
});

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

// ============================================================================
// POST /admin/test-micro-extract - Test micro text extraction (no TTS)
// ============================================================================

adminRouter.post(
  '/test-micro-extract',
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { text?: string };
    const testText = body.text || `This is a comprehensive test of the micro-first text-to-speech strategy. The system should generate a small audio preview within seconds, allowing you to start listening immediately. After the preview is ready, the full audio will be generated in the background. This approach dramatically reduces the time-to-first-audio for longer content, making the listening experience much more responsive. The micro-preview contains just the first couple of sentences, while the full audio contains the complete text. Both are uploaded to cloud storage and made available via signed URLs.`;

    // Import the extraction function (note: it's not exported, so we'll inline the logic)
    const MICRO_TARGET_CHARS = 200;
    const MICRO_MAX_SENTENCES = 2;
    const SHORT_TEXT_THRESHOLD = 500;

    // Split into sentences
    const sentencePattern = /[.!?]+[\s]+|[.!?]+$/g;
    const sentences: string[] = [];
    let lastIndex = 0;
    let match;
    const cleanText = testText.trim();

    while ((match = sentencePattern.exec(cleanText)) !== null) {
      const sentence = cleanText.slice(lastIndex, match.index + match[0].length).trim();
      if (sentence) sentences.push(sentence);
      lastIndex = match.index + match[0].length;
    }
    const remaining = cleanText.slice(lastIndex).trim();
    if (remaining) sentences.push(remaining);

    // Extract micro text
    let microText = '';
    let sentenceCount = 0;
    for (const sentence of sentences) {
      if (sentenceCount === 0) {
        microText = sentence;
        sentenceCount++;
        continue;
      }
      if ((microText + ' ' + sentence).trim().length > MICRO_TARGET_CHARS || sentenceCount >= MICRO_MAX_SENTENCES) {
        break;
      }
      microText = microText + ' ' + sentence;
      sentenceCount++;
    }

    const isShortText = cleanText.length < SHORT_TEXT_THRESHOLD;
    const microLength = microText.length;
    const remainingText = cleanText.slice(microLength).trim();

    res.json({
      input_length: cleanText.length,
      is_short_text: isShortText,
      would_use_micro_first: !isShortText,
      sentence_count: sentences.length,
      micro_text: microText,
      micro_length: microLength,
      micro_sentences: sentenceCount,
      remaining_length: remainingText.length,
    });
  })
);

// ============================================================================
// POST /admin/test-micro-first - Test Micro-First TTS Flow End-to-End
// ============================================================================

interface TestMicroFirstRequest {
  text?: string;
  voice_id?: string;
}

interface TestMicroFirstResponse {
  success: boolean;
  job_id: string;
  stages: {
    job_created: boolean;
    partial_ready: boolean;
    ready: boolean;
  };
  timing: {
    job_create_ms: number;
    partial_ready_ms: number | null;
    total_ms: number;
  };
  job_data: {
    status: string;
    preview_audio_path: string | null;
    full_audio_path: string | null;
    preview_duration_sec: number | null;
    duration_sec: number | null;
  } | null;
  preview_url: string | null;
  full_url: string | null;
  error?: string;
}

adminRouter.post(
  '/test-micro-first',
  asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const body = req.body as TestMicroFirstRequest;

    // Default long test text to trigger micro-first flow
    const testText = body.text || `This is a comprehensive test of the micro-first text-to-speech strategy. The system should generate a small audio preview within seconds, allowing you to start listening immediately. After the preview is ready, the full audio will be generated in the background. This approach dramatically reduces the time-to-first-audio for longer content, making the listening experience much more responsive. The micro-preview contains just the first couple of sentences, while the full audio contains the complete text. Both are uploaded to cloud storage and made available via signed URLs.`;
    const voiceId = body.voice_id || 'Rachel'; // Default ElevenLabs voice

    const jobId = crypto.randomUUID();
    const testUserId = '00000000-0000-0000-0000-000000000000'; // Test user UUID
    const cacheKey = computeCacheKey({ text: testText, voiceId, modelId: 'elevenlabs', speed: 1.0 });

    adminLogger.info({
      jobId,
      textLength: testText.length,
      voiceId,
    }, 'Starting micro-first test');

    const response: TestMicroFirstResponse = {
      success: false,
      job_id: jobId,
      stages: {
        job_created: false,
        partial_ready: false,
        ready: false,
      },
      timing: {
        job_create_ms: 0,
        partial_ready_ms: null,
        total_ms: 0,
      },
      job_data: null,
      preview_url: null,
      full_url: null,
    };

    try {
      // Stage 1: Create job in database
      const createStart = Date.now();

      const { error: jobError } = await supabase
        .from('tts_jobs')
        .insert({
          id: jobId,
          user_id: testUserId,
          status: 'queued',
          voice_id: voiceId,
          model_id: 'elevenlabs',
          speed: 1.0,
          cache_key: cacheKey,
          input_char_count: testText.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

      if (jobError) {
        throw new Error(`Failed to create job: ${jobError.message}`);
      }

      // Store text separately
      const { error: textError } = await supabase
        .from('tts_job_texts')
        .insert({
          job_id: jobId,
          text: testText,
        });

      if (textError) {
        throw new Error(`Failed to store job text: ${textError.message}`);
      }

      response.timing.job_create_ms = Date.now() - createStart;
      response.stages.job_created = true;

      adminLogger.info({ jobId, createMs: response.timing.job_create_ms }, 'Test job created');

      // Stage 2: Process the job (this triggers micro-first flow)
      // Run synchronously without concurrent polling to avoid potential issues
      adminLogger.info({ jobId }, 'Starting job processing');

      try {
        await processJobById(jobId);
        adminLogger.info({ jobId }, 'Job processing completed');
      } catch (processError) {
        adminLogger.error({
          jobId,
          error: processError instanceof Error ? processError.message : 'Unknown',
          stack: processError instanceof Error ? processError.stack : undefined,
        }, 'Job processing failed');
        throw processError;
      }

      response.timing.total_ms = Date.now() - startTime;

      // Stage 3: Get final job data
      const { data: finalJob } = await supabase
        .from('tts_jobs')
        .select('status, preview_audio_path, full_audio_path, preview_duration_sec, duration_sec, audio_path')
        .eq('id', jobId)
        .single();

      if (finalJob) {
        response.stages.ready = finalJob.status === 'ready';
        response.job_data = {
          status: finalJob.status,
          preview_audio_path: finalJob.preview_audio_path,
          full_audio_path: finalJob.full_audio_path || finalJob.audio_path,
          preview_duration_sec: finalJob.preview_duration_sec,
          duration_sec: finalJob.duration_sec,
        };

        // Generate signed URLs
        if (finalJob.preview_audio_path) {
          const { data: previewUrl } = await supabase.storage
            .from('audio-cache')
            .createSignedUrl(finalJob.preview_audio_path, 3600);
          response.preview_url = previewUrl?.signedUrl || null;
        }

        const fullPath = finalJob.full_audio_path || finalJob.audio_path;
        if (fullPath) {
          const { data: fullUrl } = await supabase.storage
            .from('audio-cache')
            .createSignedUrl(fullPath, 3600);
          response.full_url = fullUrl?.signedUrl || null;
        }
      }

      response.success = response.stages.ready;

      adminLogger.info({
        jobId,
        success: response.success,
        partialReadyMs: response.timing.partial_ready_ms,
        totalMs: response.timing.total_ms,
        previewUrl: response.preview_url ? 'generated' : 'none',
        fullUrl: response.full_url ? 'generated' : 'none',
      }, 'Micro-first test completed');

      // Clean up test job
      await supabase.from('tts_jobs').delete().eq('id', jobId);
      await supabase.from('tts_job_texts').delete().eq('job_id', jobId);

      res.json(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      response.error = errorMessage;
      response.timing.total_ms = Date.now() - startTime;

      adminLogger.error({
        jobId,
        error: errorMessage,
      }, 'Micro-first test failed');

      // Clean up on error
      await supabase.from('tts_jobs').delete().eq('id', jobId);
      await supabase.from('tts_job_texts').delete().eq('job_id', jobId);

      res.status(500).json(response);
    }
  })
);
