import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { ttsLogger } from '../lib/logger.js';
import {
  canSynthesize,
  canSynthesizeV2,
  logTTSUsage,
  getUserTier,
  isUserAllowlistedForJobApi,
  getCachedAudio,
  createTTSJob,
  getTTSJobForUser,
  getSignedAudioUrl,
  upsertCacheEntry,
  uploadAudioToCache,
  updateTTSJobProgress,
  supabase,
} from '../lib/supabaseClient.js';
import {
  computeCacheKey,
  computeTextHash,
  generateAudioPath,
} from '../lib/cacheKey.js';
import { ttsProvider, estimateCost, estimateDurationMs } from '../lib/ttsProviderClient.js';
import { hasRequiredTier } from '../lib/auth.js';
import { MAX_TEXT_LENGTH, TIER_LIMITS, CHARS_PER_SECOND } from '../lib/config.js';
import {
  normalizeVoiceId,
  getVoiceInfo,
  isKokoroVoiceId,
  getDefaultVoiceId,
} from '../lib/voiceMapping.js';
import { publishTTSJob } from '../lib/pubsub.js';
import { getElevenLabsClient, isElevenLabsConfigured } from '../lib/elevenLabsClient.js';
import type {
  AuthenticatedRequest,
  TTSProvider,
  AudioFormat,
  CreateTTSJobResponse,
  TTSJobStatusResponse,
} from '../types/index.js';
import {
  ValidationError,
  AuthorizationError,
  QuotaExceededError,
  NotFoundError,
} from '../types/index.js';

// ============================================================================
// Fast Lane Micro Generation (Inline)
// ============================================================================

// Micro-preview configuration (must match ttsJobWorker.ts)
const MICRO_TARGET_CHARS = 150;
const MICRO_MAX_CHARS = 200;
const MICRO_MIN_CHARS = 50;
const INLINE_MICRO_TIMEOUT_MS = 2500;  // 2.5 second timeout for inline micro

/**
 * Extract micro text (first sentence or first ~150 chars).
 * Simplified version for inline use.
 */
function extractMicroTextInline(text: string): string {
  const cleanText = text.trim();

  if (cleanText.length <= MICRO_TARGET_CHARS) {
    return cleanText;
  }

  // Try to find first sentence
  const sentenceMatch = cleanText.match(/^[^.!?]+[.!?]/);
  if (sentenceMatch && sentenceMatch[0].length <= MICRO_MAX_CHARS && sentenceMatch[0].length >= MICRO_MIN_CHARS) {
    return sentenceMatch[0].trim();
  }

  // Try to find a clause boundary
  const clauseMatch = cleanText.slice(0, MICRO_MAX_CHARS).match(/^(.+?[,;:—–-])\s/);
  if (clauseMatch && clauseMatch[1] && clauseMatch[1].length >= MICRO_MIN_CHARS) {
    return clauseMatch[1].trim();
  }

  // Fall back to word boundary
  const spaceIndex = cleanText.lastIndexOf(' ', MICRO_TARGET_CHARS);
  if (spaceIndex > MICRO_TARGET_CHARS * 0.7) {
    return cleanText.slice(0, spaceIndex);
  }

  return cleanText.slice(0, MICRO_TARGET_CHARS);
}

/**
 * Generate micro audio inline with timeout.
 * Returns null if generation fails or times out.
 */
async function generateMicroInline(
  jobId: string,
  text: string,
  voiceId: string,
  timeoutMs: number = INLINE_MICRO_TIMEOUT_MS
): Promise<{ microUrl: string; microDurationSec: number } | null> {
  if (!isElevenLabsConfigured()) {
    return null;
  }

  const elevenLabs = getElevenLabsClient();
  if (!elevenLabs) {
    return null;
  }

  const microText = extractMicroTextInline(text);
  ttsLogger.info({ jobId, microTextLength: microText.length }, 'Fast lane: generating micro inline');

  const startTime = Date.now();

  try {
    // Race between synthesis and timeout
    const microPromise = elevenLabs.synthesizeWithMetrics({
      text: microText,
      voiceId,
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });

    const result = await Promise.race([microPromise, timeoutPromise]);

    if (!result) {
      ttsLogger.warn({ jobId, elapsedMs: Date.now() - startTime }, 'Fast lane: micro generation timed out');
      return null;
    }

    // Upload micro.mp3
    const microPath = `audio/jobs/${jobId}/micro.mp3`;
    await uploadAudioToCache(microPath, result.audioBuffer, 'mp3');

    // Estimate duration (128kbps = 16KB/sec)
    const microDurationSec = Math.round(result.audioBuffer.length / 16000);

    // Update job to partial_ready with micro URL
    await supabase
      .from('tts_jobs')
      .update({
        status: 'partial_ready',
        preview_audio_path: microPath,
        preview_duration_sec: microDurationSec,
        progress_sec: microDurationSec,
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    // Get signed URL for micro
    const microUrl = await getSignedAudioUrl(microPath);
    if (!microUrl) {
      ttsLogger.error({ jobId, microPath }, 'Fast lane: failed to get signed URL for micro');
      return null;
    }

    const elapsedMs = Date.now() - startTime;
    ttsLogger.info({ jobId, microDurationSec, microSize: result.audioBuffer.length, elapsedMs }, 'Fast lane: micro ready');

    return { microUrl, microDurationSec };
  } catch (error) {
    ttsLogger.error({ jobId, error }, 'Fast lane: micro generation failed');
    return null;
  }
}

// ============================================================================
// Async Handler Wrapper
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

// ============================================================================
// Router
// ============================================================================

export const ttsRouter = Router();

// ============================================================================
// Request Validation
// ============================================================================

const ttsRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  // Voice ID - Kokoro ID (e.g., 'am_adam')
  voice_id: z.string().min(1).max(100),
  // Provider - only selfhosted (Kokoro) is supported
  provider: z.enum(['selfhosted']).default('selfhosted'),
  options: z
    .object({
      speed: z.number().min(0.5).max(3.0).optional(),
      format: z.enum(['mp3', 'wav', 'ogg']).optional(),
    })
    .optional(),
  article_id: z.string().uuid().optional(),
  article_title: z.string().max(500).optional(),
});

// ============================================================================
// POST /tts - Generate audio from text
// ============================================================================

ttsRouter.post('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const clientIp = req.ip ?? req.socket.remoteAddress;
  const userAgent = req.get('User-Agent');

  // 1. Validate request body
  const parseResult = ttsRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text, voice_id, options, article_id, article_title } = parseResult.data;
  const characterCount = text.length;

  ttsLogger.info({ userId, characterCount, voiceId: voice_id }, 'TTS request received');

  // 2. Build voice configuration from request
  const voiceInfo = getVoiceInfo(voice_id);
  const voiceName = voiceInfo?.name ?? 'Custom Voice';
  const voiceGender = voiceInfo?.gender ?? 'male';

  // Normalize voice ID to Kokoro format
  const providerVoiceId = normalizeVoiceId(voice_id);

  ttsLogger.info(
    { voiceId: voice_id, providerVoiceId, voiceName },
    'Resolved voice configuration'
  );

  // Create voice object for TTS provider
  const voice = {
    id: voice_id,
    name: voiceName,
    description: 'Kokoro voice',
    style: 'conversational' as const,
    category: 'general' as const,
    provider: 'selfhosted' as const,
    provider_voice_id: providerVoiceId,
    provider_model_id: null,
    language: 'en-US',
    gender: voiceGender as 'male' | 'female',
    is_premium: false,
    tier_required: 'free' as const,
    settings: {},
    sample_audio_url: null,
    sample_text: 'Hello, this is a sample of my voice.',
    sort_order: 1,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // 3. Check user tier (all voices currently available to free tier)
  const userTier = await getUserTier(userId);
  if (!hasRequiredTier(userTier, voice.tier_required)) {
    throw new AuthorizationError('This voice requires a higher subscription tier', {
      required_tier: voice.tier_required,
      current_tier: userTier,
    });
  }

  // 4. Check quota
  // DEBUG: Allow bypassing quota for testing via header
  // TODO: Remove this before production or gate behind environment variable
  const debugBypassQuota = req.headers['x-debug-bypass-quota'] === 'true';
  if (debugBypassQuota) {
    ttsLogger.warn({ userId }, 'DEBUG: Quota bypass enabled via header (main TTS route)');
  }

  const quotaCheck = await canSynthesize(userId, characterCount);
  if (!debugBypassQuota && !quotaCheck.allowed) {
    throw new QuotaExceededError(quotaCheck.reason ?? 'Quota exceeded', quotaCheck);
  }

  // 5. Synthesize audio
  const synthesisResult = await ttsProvider.synthesize(voice, text, {
    speed: options?.speed,
    format: options?.format,
  });

  // 6. Log usage
  const estimatedCost = estimateCost('selfhosted', characterCount);
  const estimatedDuration = estimateDurationMs(characterCount, options?.speed);

  await logTTSUsage({
    user_id: userId,
    voice_id: voice_id,
    provider: 'selfhosted',
    provider_voice_id: voice.provider_voice_id,
    characters_used: characterCount,
    audio_duration_ms: synthesisResult.durationMs ?? estimatedDuration,
    estimated_cost_usd: estimatedCost,
    article_id: article_id ?? null,
    article_title: article_title ?? null,
    success: true,
    error_code: null,
    error_message: null,
    ip_address: clientIp ?? null,
    user_agent: userAgent ?? null,
  });

  // 7. Return audio with metadata
  const contentType = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  }[synthesisResult.format] ?? 'audio/wav';

  res.set({
    'Content-Type': contentType,
    'Content-Length': synthesisResult.audioBuffer.length.toString(),
    'X-Characters-Used': characterCount.toString(),
    'X-Audio-Duration-Ms': (synthesisResult.durationMs ?? estimatedDuration).toString(),
    'X-Daily-Used': quotaCheck.daily_used.toString(),
    'X-Daily-Limit': quotaCheck.daily_limit.toString(),
    'X-Monthly-Used': quotaCheck.monthly_used.toString(),
    'X-Monthly-Limit': quotaCheck.monthly_limit.toString(),
    'X-TTS-Provider': 'selfhosted',
  });

  res.send(synthesisResult.audioBuffer);
}));

// ============================================================================
// POST /tts/preview - Generate a short preview (rate-limited, no quota charge)
// ============================================================================

const previewRequestSchema = z.object({
  // Voice ID - Kokoro voice ID
  voice_id: z.string().min(1).max(100),
  text: z.string().max(200).optional(),
});

ttsRouter.post('/preview', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  // Validate request
  const parseResult = previewRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body');
  }

  const { voice_id, text } = parseResult.data;

  // Build voice configuration using centralized mapping
  const voiceInfo = getVoiceInfo(voice_id);
  const voiceName = voiceInfo?.name ?? 'Custom Voice';
  const voiceGender = voiceInfo?.gender ?? 'male';

  // Normalize voice ID to Kokoro format
  const providerVoiceId = normalizeVoiceId(voice_id);

  const voice = {
    id: voice_id,
    name: voiceName,
    description: 'Kokoro voice',
    style: 'conversational' as const,
    category: 'general' as const,
    provider: 'selfhosted' as const,
    provider_voice_id: providerVoiceId,
    provider_model_id: null,
    language: 'en-US',
    gender: voiceGender as 'male' | 'female',
    is_premium: false,
    tier_required: 'free' as const,
    settings: {},
    sample_audio_url: null,
    sample_text: 'Hello, this is a sample of my voice.',
    sort_order: 1,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Use sample text if no custom text provided
  const previewText = text ?? voice.sample_text;

  ttsLogger.info({ userId, voiceId: voice_id, voiceName }, 'Preview request');

  // Synthesize (previews don't count against quota)
  const result = await ttsProvider.synthesize(voice, previewText);

  res.set({
    'Content-Type': 'audio/wav',
    'Content-Length': result.audioBuffer.length.toString(),
    'Cache-Control': 'public, max-age=3600',
    'X-TTS-Provider': 'selfhosted',
  });

  res.send(result.audioBuffer);
}));

// ============================================================================
// POST /tts/stream - Stream audio chunks as they're synthesized
// ============================================================================

ttsRouter.post('/stream', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const clientIp = req.ip ?? req.socket.remoteAddress;
  const userAgent = req.get('User-Agent');

  // 1. Validate request body (uses same schema as POST /tts)
  const parseResult = ttsRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text, voice_id, options, article_id, article_title } = parseResult.data;
  const characterCount = text.length;

  ttsLogger.info({ userId, characterCount, voiceId: voice_id }, 'TTS stream request received');

  // 2. Build voice configuration using centralized mapping
  const voiceInfo = getVoiceInfo(voice_id);
  const voiceName = voiceInfo?.name ?? 'Custom Voice';
  const voiceGender = voiceInfo?.gender ?? 'male';

  // Normalize voice ID to Kokoro format
  const kokoroVoiceId = normalizeVoiceId(voice_id);

  const voice = {
    id: voice_id,
    name: voiceName,
    description: 'Kokoro voice',
    style: 'conversational' as const,
    category: 'general' as const,
    provider: 'selfhosted' as const,
    provider_voice_id: kokoroVoiceId,
    provider_model_id: null,
    language: 'en-US',
    gender: voiceGender as 'male' | 'female',
    is_premium: false,
    tier_required: 'free' as const,
    settings: {},
    sample_audio_url: null,
    sample_text: 'Hello, this is a sample of my voice.',
    sort_order: 1,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  ttsLogger.info(
    { voiceId: voice_id, kokoroVoiceId, voiceName },
    'Resolved voice for streaming'
  );

  // 3. Check user tier
  const userTier = await getUserTier(userId);
  if (!hasRequiredTier(userTier, voice.tier_required)) {
    throw new AuthorizationError('This voice requires a higher subscription tier', {
      required_tier: voice.tier_required,
      current_tier: userTier,
    });
  }

  // 4. Check quota upfront
  const quotaCheck = await canSynthesize(userId, characterCount);
  if (!quotaCheck.allowed) {
    throw new QuotaExceededError(quotaCheck.reason ?? 'Quota exceeded', quotaCheck);
  }

  // 5. Set streaming headers
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Characters-Used', characterCount.toString());
  res.setHeader('X-Daily-Used', quotaCheck.daily_used.toString());
  res.setHeader('X-Daily-Limit', quotaCheck.daily_limit.toString());
  res.setHeader('X-Monthly-Used', quotaCheck.monthly_used.toString());
  res.setHeader('X-Monthly-Limit', quotaCheck.monthly_limit.toString());
  res.setHeader('X-TTS-Provider', 'selfhosted');

  // 6. Stream chunks from TTS service
  let totalChunks = 0;
  let totalDurationMs = 0;

  try {
    for await (const chunk of ttsProvider.synthesizeStream(voice, text, {
      speed: options?.speed,
    })) {
      res.write(JSON.stringify(chunk) + '\n');
      totalChunks++;
      totalDurationMs += chunk.duration_ms;

      if (chunk.error) {
        ttsLogger.error({ error: chunk.error, chunkIndex: chunk.index }, 'TTS stream chunk error');
        break;
      }
    }
  } catch (error) {
    ttsLogger.error({ error }, 'TTS streaming failed');
    res.write(JSON.stringify({
      index: totalChunks,
      total: totalChunks,
      error: error instanceof Error ? error.message : 'Streaming failed',
      final: true,
    }) + '\n');
  }

  res.end();

  // 7. Log usage after streaming completes
  const estimatedCost = estimateCost('selfhosted', characterCount);

  await logTTSUsage({
    user_id: userId,
    voice_id: voice_id,
    provider: 'selfhosted',
    provider_voice_id: kokoroVoiceId,
    characters_used: characterCount,
    audio_duration_ms: totalDurationMs,
    estimated_cost_usd: estimatedCost,
    article_id: article_id ?? null,
    article_title: article_title ?? null,
    success: true,
    error_code: null,
    error_message: null,
    ip_address: clientIp ?? null,
    user_agent: userAgent ?? null,
  });

  ttsLogger.info(
    { userId, totalChunks, totalDurationMs, characterCount },
    'TTS streaming completed'
  );
}));

// ============================================================================
// POST /tts/estimate - Get usage estimate without synthesizing
// ============================================================================

const estimateRequestSchema = z.object({
  text_length: z.number().int().positive(),
  voice_id: z.string().min(1).max(100),
  speed: z.number().min(0.5).max(3.0).optional(),
});

ttsRouter.post('/estimate', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  const parseResult = estimateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body');
  }

  const { text_length, speed } = parseResult.data;

  // Check quota
  const quotaCheck = await canSynthesize(userId, text_length);

  // Estimate cost and duration (always selfhosted)
  const estimatedCost = estimateCost('selfhosted', text_length);
  const estimatedDuration = estimateDurationMs(text_length, speed);

  res.json({
    can_proceed: quotaCheck.allowed,
    reason: quotaCheck.reason,
    estimate: {
      characters: text_length,
      estimated_duration_ms: estimatedDuration,
      estimated_cost_usd: estimatedCost,
    },
    quota: {
      daily: {
        used: quotaCheck.daily_used,
        limit: quotaCheck.daily_limit,
        remaining: quotaCheck.daily_limit - quotaCheck.daily_used,
        after_request: quotaCheck.daily_used + text_length,
      },
      monthly: {
        used: quotaCheck.monthly_used,
        limit: quotaCheck.monthly_limit,
        remaining: quotaCheck.monthly_limit - quotaCheck.monthly_used,
        after_request: quotaCheck.monthly_used + text_length,
      },
    },
  });
}));

// ============================================================================
// POST /tts/job - Create a TTS job (async job-based API)
// ============================================================================
// For allowlisted users: checks cache first, returns ready with audioUrl if hit,
// otherwise creates a job and returns processing with jobId.
// For non-allowlisted users: returns 404 (they use the old streaming API).

const jobRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  voice_id: z.string().min(1).max(100),
  // Provider selection:
  // - "selfhosted": Kokoro TTS (default, fast, unlimited)
  // - "elevenlabs": ElevenLabs TTS (premium, higher quality)
  provider: z.enum(['selfhosted', 'elevenlabs']).default('selfhosted'),
  options: z
    .object({
      speed: z.number().min(0.5).max(3.0).optional(),
      format: z.enum(['mp3', 'wav', 'ogg']).optional(),
    })
    .optional(),
  article_id: z.string().uuid().optional(),
  article_title: z.string().max(500).optional(),
  // Purpose of the synthesis request:
  // - "play": User pressed play, expects immediate response
  // - "prewarm": Background pre-synthesis on import, lower priority
  purpose: z.enum(['play', 'prewarm']).default('play'),
});

ttsRouter.post('/job', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  // 1. Check if user is allowlisted for job API
  if (!isUserAllowlistedForJobApi(userId)) {
    throw new NotFoundError('Endpoint');
  }

  // 2. Validate request body
  const parseResult = jobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text, voice_id, provider, options, article_id, article_title, purpose } = parseResult.data;
  const characterCount = text.length;
  const speed = options?.speed ?? 1.0;
  const format: AudioFormat = options?.format ?? 'mp3';
  // Model ID depends on provider
  const modelId = provider === 'elevenlabs' ? 'eleven_multilingual_v2' : 'kokoro-82m';

  ttsLogger.info({ userId, characterCount, voiceId: voice_id, provider, purpose }, 'TTS job request received');

  // 3. Build voice configuration
  const voiceInfo = getVoiceInfo(voice_id);
  // For ElevenLabs, use the voice_id as-is (it's already an ElevenLabs ID)
  // For Kokoro/selfhosted, normalize to Kokoro format
  const providerVoiceId = provider === 'elevenlabs' ? voice_id : normalizeVoiceId(voice_id);

  // 4. Check user tier (all Kokoro voices are free tier)
  const userTier = await getUserTier(userId);
  const requiredTier = 'free' as const;
  if (!hasRequiredTier(userTier, requiredTier)) {
    throw new AuthorizationError('This voice requires a higher subscription tier', {
      required_tier: requiredTier,
      current_tier: userTier,
    });
  }

  // 5. Check quota (v2 with seconds tracking and max chars per job)
  // DEBUG: Allow bypassing quota for testing via header
  // TODO: Remove this before production or gate behind environment variable
  const debugBypassQuota = req.headers['x-debug-bypass-quota'] === 'true';
  if (debugBypassQuota) {
    ttsLogger.warn({ userId }, 'DEBUG: Quota bypass enabled via header');
  }

  const quotaCheck = await canSynthesizeV2(userId, characterCount);

  // First check max chars per job (skip if debug bypass)
  if (!debugBypassQuota && characterCount > quotaCheck.max_chars_per_job) {
    throw new ValidationError(
      `Text too long. Maximum ${quotaCheck.max_chars_per_job.toLocaleString()} characters per job for ${quotaCheck.tier} tier. Upgrade for higher limits.`,
      {
        max_chars: quotaCheck.max_chars_per_job,
        current_chars: characterCount,
        tier: quotaCheck.tier,
      }
    );
  }

  if (!debugBypassQuota && !quotaCheck.allowed) {
    throw new QuotaExceededError(quotaCheck.reason ?? 'Quota exceeded', quotaCheck);
  }

  // Store tier info for rate limiting and priority queue
  const jobPriority = quotaCheck.priority;

  // 6. Compute cache key
  const cacheKey = computeCacheKey({
    text,
    voiceId: providerVoiceId,
    modelId,
    speed,
    format,
  });
  const textHash = computeTextHash(text);

  ttsLogger.info({ cacheKey, textHash }, 'Computed cache key');

  // 7. Check cache first
  const cachedAudio = await getCachedAudio(cacheKey);
  if (cachedAudio) {
    // Cache hit! Get signed URL and return immediately
    const audioUrl = await getSignedAudioUrl(cachedAudio.audioPath);

    if (audioUrl) {
      ttsLogger.info({ cacheKey, hits: cachedAudio.hits }, 'Cache hit - returning cached audio');

      const response: CreateTTSJobResponse = {
        job_id: `cache-${cacheKey.substring(0, 8)}`, // Pseudo job ID for cache hits
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      };

      res.json(response);
      return;
    }
    // If signed URL failed, fall through to create job
    ttsLogger.warn({ cacheKey }, 'Cache entry exists but failed to get signed URL');
  }

  // 8. No cache hit - create a new job
  const job = await createTTSJob({
    userId,
    voiceId: providerVoiceId,
    modelId,
    speed,
    format,
    inputTextHash: textHash,
    inputCharCount: characterCount,
    cacheKey,
    text,  // Store text for worker to process
    articleId: article_id,
    articleTitle: article_title,
  });

  // 9. FAST LANE: For "play" purpose with ElevenLabs, generate micro inline
  // This reduces TTFS by avoiding Pub/Sub worker pickup latency
  let microResult: { microUrl: string; microDurationSec: number } | null = null;

  if (purpose === 'play' && isElevenLabsConfigured() && characterCount > 200) {
    // Only use fast lane for longer texts (short texts will be fully synthesized by worker quickly)
    ttsLogger.info({ jobId: job.id, purpose }, 'Attempting fast lane micro generation');
    microResult = await generateMicroInline(job.id, text, providerVoiceId);
  }

  // 10. Publish job to Pub/Sub queue for async processing (preview + full)
  try {
    await publishTTSJob(job.id);
    ttsLogger.info({ jobId: job.id }, 'Published job to Pub/Sub queue');
  } catch (pubsubError) {
    // Log error but don't fail - worker will still pick up job from DB
    ttsLogger.error({ error: pubsubError, jobId: job.id }, 'Failed to publish to Pub/Sub, will rely on DB polling');
  }

  // 11. Estimate wait time based on character count
  const estimatedWaitSec = Math.ceil(characterCount / 500); // ~500 chars/sec processing

  ttsLogger.info({ jobId: job.id, cacheKey, estimatedWaitSec, hasMicro: !!microResult }, 'TTS job created');

  // 12. Return response - partial_ready if micro was generated, otherwise processing
  if (microResult) {
    // Fast lane success - return partial_ready with micro URL immediately
    const response: CreateTTSJobResponse = {
      job_id: job.id,
      status: 'partial_ready',
      cache_hit: false,
      estimated_wait_sec: estimatedWaitSec,
      preview_url: microResult.microUrl,
      preview_duration_sec: microResult.microDurationSec,
    };

    ttsLogger.info({ jobId: job.id, microUrl: microResult.microUrl }, 'Fast lane: returning partial_ready with micro URL');
    res.status(202).json(response);
  } else {
    // No fast lane - return processing status
    const response: CreateTTSJobResponse = {
      job_id: job.id,
      status: 'processing',
      cache_hit: false,
      estimated_wait_sec: estimatedWaitSec,
    };

    res.status(202).json(response);
  }
}));

// ============================================================================
// GET /tts/job/:jobId - Get job status (polling endpoint)
// ============================================================================

ttsRouter.get('/job/:jobId', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { jobId } = req.params;

  // 1. Check if user is allowlisted for job API
  if (!isUserAllowlistedForJobApi(userId)) {
    throw new NotFoundError('Endpoint');
  }

  // 2. Validate jobId format (UUID or cache-* pseudo ID)
  if (!jobId) {
    throw new ValidationError('Job ID is required');
  }

  // 3. Handle cache pseudo-IDs (from cache hits)
  if (jobId.startsWith('cache-')) {
    // These are always ready - the audio URL was already returned
    const response: TTSJobStatusResponse = {
      job_id: jobId,
      status: 'ready',
      progress: {
        duration_sec: null,
        progress_sec: 0,
        chunks_total: null,
        chunks_completed: 0,
        percentage: 100,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    res.json(response);
    return;
  }

  // 4. Look up real job
  const job = await getTTSJobForUser(jobId, userId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  // 5. Estimate total duration if not yet known
  // Use actual duration if available, otherwise estimate from preview or character count
  let estimatedDurationSec: number | null = job.duration_sec;

  if (!estimatedDurationSec && job.input_char_count) {
    // If we have preview_duration_sec, use it to calculate actual speech rate
    // Preview is ~150-200 chars (MICRO_TARGET_CHARS), so we can extrapolate
    if (job.preview_duration_sec && job.preview_duration_sec > 0) {
      // Use measured rate from preview: audio_sec_per_char = preview_duration / preview_chars
      // Preview is approximately MICRO_TARGET_CHARS (150) characters
      const previewChars = MICRO_TARGET_CHARS;  // ~150 chars
      const audioSecPerChar = job.preview_duration_sec / previewChars;
      estimatedDurationSec = Math.round(job.input_char_count * audioSecPerChar);
      ttsLogger.debug({
        jobId,
        previewDurationSec: job.preview_duration_sec,
        previewChars,
        audioSecPerChar,
        inputChars: job.input_char_count,
        estimatedDurationSec,
      }, 'Estimated duration from preview');
    } else {
      // Fallback: average speech rate ~150 words/min = 2.5 words/sec, ~5 chars/word = 12.5 chars/sec
      estimatedDurationSec = Math.round(job.input_char_count / 12.5);
    }
  }

  // 6. Calculate progress percentage and estimated remaining synthesis time
  let percentage = 0;
  let estimatedRemainingSec: number | undefined;

  if (job.status === 'ready' || job.status === 'failed' || job.status === 'canceled') {
    percentage = 100;
    estimatedRemainingSec = 0;
  } else if (job.chunks_total && job.chunks_total > 0) {
    percentage = Math.round((job.chunks_completed / job.chunks_total) * 100);
  } else if (estimatedDurationSec && estimatedDurationSec > 0 && job.progress_sec > 0) {
    percentage = Math.round((job.progress_sec / estimatedDurationSec) * 100);
  }

  // Calculate estimated remaining synthesis time based on measured rate from preview
  if (job.preview_generation_ms && job.preview_duration_sec && job.preview_duration_sec > 0 && estimatedDurationSec) {
    // Synthesis rate = preview_audio_duration / preview_generation_time
    // e.g., 10 sec audio generated in 1.25 sec = 8x realtime
    const synthesisRate = job.preview_duration_sec / (job.preview_generation_ms / 1000);
    const remainingAudioSec = estimatedDurationSec - job.progress_sec;
    // Remaining synthesis time = remaining audio / synthesis rate
    estimatedRemainingSec = Math.max(0, Math.round(remainingAudioSec / synthesisRate));

    ttsLogger.debug({
      jobId,
      previewDurationSec: job.preview_duration_sec,
      previewGenerationMs: job.preview_generation_ms,
      synthesisRate: synthesisRate.toFixed(1) + 'x',
      remainingAudioSec,
      estimatedRemainingSec,
    }, 'Calculated synthesis time remaining from measured rate');
  } else if (estimatedDurationSec && job.progress_sec >= 0) {
    // Fallback: estimate based on synthesis type
    const remainingAudioSec = estimatedDurationSec - job.progress_sec;

    // Cloned voices are much slower than Kokoro
    // XTTS: ~0.5x realtime (synthesis takes 2x audio duration)
    // Chatterbox: ~0.3x realtime (synthesis takes 3.3x audio duration)
    // Kokoro GPU: ~8x realtime
    let synthesisRate: number;
    if (job.cloning_model === 'chatterbox') {
      synthesisRate = 0.3;  // 3.3x slower than realtime
    } else if (job.cloning_model === 'xtts') {
      synthesisRate = 0.5;  // 2x slower than realtime
    } else {
      synthesisRate = 8;  // Kokoro GPU is fast
    }

    estimatedRemainingSec = Math.max(0, Math.round(remainingAudioSec / synthesisRate));
  }

  // 7. Get audio URLs based on status
  let audioUrl: string | undefined;
  let previewUrl: string | undefined;
  let previewDurationSec: number | undefined;

  // Get preview URL if available (partial_ready or ready)
  if ((job.status === 'partial_ready' || job.status === 'ready') && job.preview_audio_path) {
    previewUrl = await getSignedAudioUrl(job.preview_audio_path) ?? undefined;
    previewDurationSec = job.preview_duration_sec ?? undefined;
  }

  // Get full audio URL if ready
  if (job.status === 'ready') {
    // Prefer full_audio_path, fallback to audio_path for backwards compatibility
    const fullPath = job.full_audio_path || job.audio_path;
    if (fullPath) {
      audioUrl = await getSignedAudioUrl(fullPath) ?? undefined;
    }
  }

  // 8. Build response
  const response: TTSJobStatusResponse = {
    job_id: job.id,
    status: job.status,
    progress: {
      duration_sec: estimatedDurationSec,  // Use estimated if actual not yet known
      progress_sec: job.progress_sec,
      chunks_total: job.chunks_total,
      chunks_completed: job.chunks_completed,
      percentage,
      estimated_remaining_sec: estimatedRemainingSec,  // Estimated synthesis time remaining
    },
    audio_url: audioUrl,
    preview_url: previewUrl,
    preview_duration_sec: previewDurationSec,
    error: job.error_code ? {
      code: job.error_code,
      message: job.error_message ?? 'Unknown error',
    } : undefined,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };

  res.json(response);
}));

// ============================================================================
// POST /tts/job/:jobId/cancel - Cancel a pending or processing job
// ============================================================================

ttsRouter.post('/job/:jobId/cancel', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { jobId } = req.params;

  // 1. Check if user is allowlisted for job API
  if (!isUserAllowlistedForJobApi(userId)) {
    throw new NotFoundError('Endpoint');
  }

  // 2. Validate jobId
  if (!jobId) {
    throw new ValidationError('Job ID is required');
  }

  // 3. Handle cache pseudo-IDs (nothing to cancel)
  if (jobId.startsWith('cache-')) {
    res.json({ success: true, message: 'Cache hit jobs cannot be cancelled' });
    return;
  }

  // 4. Look up the job and verify ownership
  const job = await getTTSJobForUser(jobId, userId);
  if (!job) {
    throw new NotFoundError('Job');
  }

  // 5. Check if job can be cancelled
  if (job.status === 'ready' || job.status === 'failed' || job.status === 'canceled') {
    res.json({
      success: true,
      message: `Job already in terminal state: ${job.status}`,
      status: job.status,
    });
    return;
  }

  // 6. Update job status to canceled
  await updateTTSJobProgress({
    jobId,
    status: 'canceled',
  });

  ttsLogger.info({ jobId, userId }, 'Job cancelled by user');

  res.json({
    success: true,
    message: 'Job cancelled',
    status: 'canceled',
  });
}));

// ============================================================================
// POST /tts/cloned - Synthesize with cloned voice via Chatterbox
// ============================================================================

const clonedVoiceSynthSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  voice_id: z.string().min(1).describe('Cloned voice ID (UUID from cloned_voices table)'),
  voice_url: z.string().url().describe('URL to reference audio file (from Supabase Storage)'),
  speed: z.number().min(0.5).max(3.0).default(1.0),  // Allow up to 3x speed to match iOS playback options
  model: z.enum(['chatterbox', 'xtts']).default('chatterbox').describe('Voice cloning model: chatterbox (quality) or xtts (fast)'),
});

ttsRouter.post('/cloned', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  // 1. Validate request body
  const parseResult = clonedVoiceSynthSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError(
      parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')
    );
  }

  const { text, voice_id: voiceId, voice_url: voiceUrl, speed, model } = parseResult.data;
  const characterCount = text.length;

  ttsLogger.info(
    { userId, voiceId, characterCount },
    'Cloned voice synthesis request'
  );

  // 2. Get GPU TTS service URL from config
  const gpuTtsUrl = process.env.GPU_TTS_URL;
  if (!gpuTtsUrl) {
    ttsLogger.error('GPU_TTS_URL not configured');
    throw new Error('GPU TTS service not configured');
  }

  // 3. Forward request to tts-service /synthesize-cloned endpoint
  const ttsServiceUrl = `${gpuTtsUrl}/synthesize-cloned`;

  ttsLogger.info(
    { ttsServiceUrl, voiceId, voiceUrl: voiceUrl.substring(0, 50) + '...', textLen: characterCount },
    'Forwarding to GPU TTS service'
  );

  try {
    const response = await fetch(ttsServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/wav',
        ...(process.env.SELFHOSTED_TTS_API_KEY
          ? { 'X-API-Key': process.env.SELFHOSTED_TTS_API_KEY }
          : {}),
      },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        voice_url: voiceUrl,
        speed,
        model,
      }),
    });

    ttsLogger.info(
      { status: response.status, voiceId },
      'GPU TTS service response received'
    );

    if (!response.ok) {
      const errorText = await response.text();
      ttsLogger.error(
        { statusCode: response.status, error: errorText, voiceId, ttsServiceUrl },
        'Cloned voice synthesis failed from GPU service'
      );
      throw new Error(`TTS service error: ${response.status} - ${errorText}`);
    }

    // 4. Stream audio response back to client
    const contentType = response.headers.get('Content-Type') || 'audio/wav';
    const synthesisTimeMs = response.headers.get('X-Synthesis-Time-Ms');

    // Set response headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Voice-ID', voiceId);
    res.setHeader('X-Model', 'chatterbox');
    res.setHeader('X-Characters-Used', characterCount.toString());
    if (synthesisTimeMs) {
      res.setHeader('X-Synthesis-Time-Ms', synthesisTimeMs);
    }

    // Get array buffer and send
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.send(audioBuffer);

    ttsLogger.info(
      { userId, voiceId, characterCount, synthesisTimeMs },
      'Cloned voice synthesis completed'
    );
  } catch (error) {
    ttsLogger.error({ error, voiceId }, 'Cloned voice synthesis error');
    throw error;
  }
}));

// ============================================================================
// POST /tts/job-cloned - Create a TTS job for cloned voice synthesis (async)
// ============================================================================
// Uses the job-based API for cloned voices, providing progress tracking
// similar to regular voice synthesis.

const clonedJobRequestSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  voice_id: z.string().min(1).describe('Cloned voice ID (UUID from cloned_voices table)'),
  voice_url: z.string().url().describe('URL to reference audio file (from Supabase Storage)'),
  speed: z.number().min(0.5).max(3.0).default(1.0),
  model: z.enum(['chatterbox', 'xtts']).default('chatterbox').describe('Voice cloning model'),
  article_id: z.string().uuid().optional(),
  article_title: z.string().max(500).optional(),
});

ttsRouter.post('/job-cloned', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  // 1. Validate request body
  const parseResult = clonedJobRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { text, voice_id: voiceId, voice_url: voiceUrl, speed, model, article_id, article_title } = parseResult.data;
  const characterCount = text.length;

  ttsLogger.info(
    { userId, voiceId, characterCount, model },
    'Cloned voice job request received'
  );

  // 2. Check quota (cloned voices use the same quota as regular synthesis)
  const debugBypassQuota = req.headers['x-debug-bypass-quota'] === 'true';
  if (debugBypassQuota) {
    ttsLogger.warn({ userId }, 'DEBUG: Quota bypass enabled for cloned voice job');
  }

  const quotaCheck = await canSynthesizeV2(userId, characterCount);

  // Check max chars per job
  if (!debugBypassQuota && characterCount > quotaCheck.max_chars_per_job) {
    throw new ValidationError(
      `Text too long. Maximum ${quotaCheck.max_chars_per_job.toLocaleString()} characters per job.`,
      {
        max_chars: quotaCheck.max_chars_per_job,
        current_chars: characterCount,
        tier: quotaCheck.tier,
      }
    );
  }

  if (!debugBypassQuota && !quotaCheck.allowed) {
    throw new QuotaExceededError(quotaCheck.reason ?? 'Quota exceeded', quotaCheck);
  }

  // 3. Compute cache key (includes voice_id and model for uniqueness)
  const modelId = model === 'chatterbox' ? 'chatterbox-v1' : 'xtts-v2';
  const cacheKey = computeCacheKey({
    text,
    voiceId: `cloned-${voiceId}`,  // Prefix to distinguish from regular voices
    modelId,
    speed,
    format: 'wav',  // Cloned voices always return WAV
  });
  const textHash = computeTextHash(text);

  ttsLogger.info({ cacheKey, textHash, model }, 'Computed cache key for cloned voice');

  // 4. Check cache first
  const cachedAudio = await getCachedAudio(cacheKey);
  if (cachedAudio) {
    const audioUrl = await getSignedAudioUrl(cachedAudio.audioPath);

    if (audioUrl) {
      ttsLogger.info({ cacheKey, hits: cachedAudio.hits }, 'Cache hit for cloned voice');

      const response: CreateTTSJobResponse = {
        job_id: `cache-${cacheKey.substring(0, 8)}`,
        status: 'ready',
        cache_hit: true,
        audio_url: audioUrl,
        estimated_wait_sec: 0,
      };

      res.json(response);
      return;
    }
    ttsLogger.warn({ cacheKey }, 'Cache entry exists but failed to get signed URL');
  }

  // 5. Create a new job with cloned voice fields
  const job = await createTTSJob({
    userId,
    voiceId: `cloned-${voiceId}`,  // Mark as cloned voice
    modelId,
    speed,
    format: 'wav',  // Cloned voices return WAV
    inputTextHash: textHash,
    inputCharCount: characterCount,
    cacheKey,
    text,
    articleId: article_id,
    articleTitle: article_title,
    // Cloned voice specific fields
    clonedVoiceId: voiceId,
    voiceUrl,
    cloningModel: model,
  });

  // 6. Publish job to Pub/Sub queue
  try {
    await publishTTSJob(job.id);
    ttsLogger.info({ jobId: job.id }, 'Published cloned voice job to Pub/Sub queue');
  } catch (pubsubError) {
    ttsLogger.error({ error: pubsubError, jobId: job.id }, 'Failed to publish cloned voice job to Pub/Sub');
  }

  // 7. Estimate wait time
  // Cloned voices are slower: XTTS ~0.5x realtime, Chatterbox ~0.3x realtime
  // Audio duration = characterCount / 12.5 chars per second
  // Synthesis time = audioDuration * synthesisMultiplier
  const audioDurationSec = characterCount / 12.5;
  const synthesisMultiplier = model === 'xtts' ? 2.0 : 3.3;  // XTTS faster, Chatterbox slower
  const estimatedWaitSec = Math.ceil(audioDurationSec * synthesisMultiplier) + 5;  // +5s overhead

  ttsLogger.info(
    { jobId: job.id, cacheKey, estimatedWaitSec, model, characterCount },
    'Cloned voice TTS job created'
  );

  // 8. Return processing status (no fast lane for cloned voices)
  const response: CreateTTSJobResponse = {
    job_id: job.id,
    status: 'processing',
    cache_hit: false,
    estimated_wait_sec: estimatedWaitSec,
  };

  res.status(202).json(response);
}));
