import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, TIER_LIMITS, CHARS_PER_SECOND } from './config.js';
import { logger } from './logger.js';
import type {
  DBUser,
  DBSubscription,
  DBVoice,
  DBTTSUsage,
  DBMonthlyQuota,
  DBDailyQuota,
  QuotaCheckResult,
  SubscriptionTier,
  DBLatencyMetric,
  DBLatencyCache,
  TTSProvider,
  DBTTSJob,
  DBTTSCache,
  TTSJobStatus,
  AudioFormat,
} from '../types/index.js';

// ============================================================================
// Retry Configuration for Network Calls
// ============================================================================

const RETRYABLE_ERRORS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'fetch failed',
];

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 500;

// Connection diagnostics
let connectionErrors: { timestamp: number; error: string; url: string }[] = [];
const MAX_ERROR_HISTORY = 50;

/**
 * Check if an error is retryable (network/transient).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message || '';
    const cause = (error as Error & { cause?: Error }).cause;

    // Check error message
    for (const errCode of RETRYABLE_ERRORS) {
      if (message.includes(errCode)) return true;
    }

    // Check cause (Node.js fetch wraps errors in cause)
    if (cause && cause.message) {
      for (const errCode of RETRYABLE_ERRORS) {
        if (cause.message.includes(errCode)) return true;
      }
    }
  }

  return false;
}

/**
 * Record connection error for diagnostics.
 */
function recordConnectionError(error: Error, url: string): void {
  const errorMsg = error.message || String(error);
  connectionErrors.push({
    timestamp: Date.now(),
    error: errorMsg,
    url: url.replace(/\?.*$/, ''), // Strip query params for privacy
  });

  // Trim old errors
  if (connectionErrors.length > MAX_ERROR_HISTORY) {
    connectionErrors = connectionErrors.slice(-MAX_ERROR_HISTORY);
  }
}

/**
 * Get recent connection errors for diagnostics.
 */
export function getConnectionDiagnostics(): {
  recentErrors: typeof connectionErrors;
  errorRate: number;
  lastErrorAgo: number | null;
} {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  const recentErrors = connectionErrors.filter(e => e.timestamp > fiveMinutesAgo);
  const lastError = connectionErrors[connectionErrors.length - 1];

  return {
    recentErrors,
    errorRate: recentErrors.length,
    lastErrorAgo: lastError ? Date.now() - lastError.timestamp : null,
  };
}

/**
 * Custom fetch with retry logic for Supabase client.
 * Handles ECONNRESET and other transient network errors.
 */
async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let lastError: Error | undefined;
  const url = typeof input === 'string' ? input : input.toString();
  const startTime = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(input, init);

      // Log slow requests (>5s)
      const elapsed = Date.now() - startTime;
      if (elapsed > 5000) {
        logger.warn({ url: url.replace(/\?.*$/, ''), elapsed, attempt }, 'Slow Supabase request');
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      recordConnectionError(lastError, url);

      // Don't retry if not a retryable error
      if (!isRetryableError(error)) {
        logger.error(
          { error: lastError.message, cause: (lastError as Error & { cause?: Error }).cause?.message, url: url.replace(/\?.*$/, '') },
          'Non-retryable Supabase error'
        );
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= MAX_RETRIES) {
        const diagnostics = getConnectionDiagnostics();
        logger.error(
          {
            error: lastError.message,
            cause: (lastError as Error & { cause?: Error }).cause?.message,
            attempt: attempt + 1,
            url: url.replace(/\?.*$/, ''),
            recentErrorCount: diagnostics.errorRate,
            elapsed: Date.now() - startTime,
          },
          `Supabase fetch failed after ${MAX_RETRIES + 1} attempts`
        );
        throw error;
      }

      // Calculate backoff delay with jitter
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;

      logger.warn(
        {
          error: lastError.message,
          cause: (lastError as Error & { cause?: Error }).cause?.message,
          attempt: attempt + 1,
          delayMs: Math.round(delay),
          url: url.replace(/\?.*$/, ''),
        },
        `Supabase fetch failed, retrying...`
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ============================================================================
// Supabase Client
// ============================================================================

/**
 * Supabase client configured with service_role key.
 * Use this for server-side operations that bypass RLS.
 * Includes custom fetch with retry logic for network resilience.
 */
export const supabase: SupabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      fetch: fetchWithRetry,
    },
  }
);

// ============================================================================
// User Operations
// ============================================================================

/**
 * Get user profile by ID.
 */
export async function getUser(userId: string): Promise<DBUser | null> {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.error({ error, userId }, 'Failed to get user');
    throw error;
  }

  return data;
}

/**
 * Get user subscription.
 */
export async function getSubscription(userId: string): Promise<DBSubscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error({ error, userId }, 'Failed to get subscription');
    throw error;
  }

  return data;
}

/**
 * Get user's subscription tier.
 */
export async function getUserTier(userId: string): Promise<SubscriptionTier> {
  // Default pro user gets unlimited tier
  if (userId === 'pro-user-default' || userId === 'dev-user-001') {
    return 'unlimited';
  }

  const subscription = await getSubscription(userId);
  return subscription?.plan_id ?? 'free';
}

// ============================================================================
// Voice Operations
// ============================================================================

/**
 * Get all active voices.
 */
export async function getVoices(filters?: {
  category?: string;
  tier?: SubscriptionTier;
}): Promise<DBVoice[]> {
  let query = supabase
    .from('voices')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });

  if (filters?.category) {
    query = query.eq('category', filters.category);
  }

  if (filters?.tier) {
    query = query.eq('tier_required', filters.tier);
  }

  const { data, error } = await query;

  if (error) {
    logger.error({ error, filters }, 'Failed to get voices');
    throw error;
  }

  return data ?? [];
}

/**
 * Get voice by ID.
 * Returns null if voice not found or if there's any database error.
 * This allows the TTS route to fall back to a default voice.
 */
export async function getVoice(voiceId: string): Promise<DBVoice | null> {
  try {
    const { data, error } = await supabase
      .from('voices')
      .select('*')
      .eq('id', voiceId)
      .eq('is_active', true)
      .single();

    if (error) {
      // PGRST116 = not found, PGRST104 = table doesn't exist
      // For any error, just return null to allow fallback
      logger.info({ error: error.code, voiceId }, 'Voice lookup failed, will use default');
      return null;
    }

    return data;
  } catch (err) {
    // Any exception should not block TTS - return null to allow fallback
    logger.info({ err, voiceId }, 'Voice lookup exception, will use default');
    return null;
  }
}

// ============================================================================
// Quota Operations
// ============================================================================

/**
 * Enhanced quota check result with seconds tracking and priority.
 */
export interface EnhancedQuotaResult extends QuotaCheckResult {
  daily_seconds_used: number;
  daily_seconds_limit: number;
  monthly_seconds_used: number;
  monthly_seconds_limit: number;
  priority: number;
  tier: SubscriptionTier;
  max_chars_per_job: number;
}

/**
 * Check if user can synthesize the given number of characters.
 * Uses the database function for atomic check.
 */
export async function canSynthesize(
  userId: string,
  characters: number
): Promise<QuotaCheckResult> {
  // For default pro user (apps without auth), always allow with pro limits
  if (userId === 'pro-user-default' || userId === 'dev-user-001') {
    logger.info({ userId, characters }, 'Default user - bypassing quota check with pro limits');
    return {
      allowed: true,
      reason: null,
      daily_used: 0,
      daily_limit: 999_999_999,  // Unlimited for pro
      monthly_used: 0,
      monthly_limit: 999_999_999,  // Unlimited for pro
    };
  }

  const { data, error } = await supabase.rpc('can_synthesize', {
    p_user_id: userId,
    p_characters: characters,
  });

  if (error) {
    logger.error({ error, userId, characters }, 'Failed to check quota');
    throw error;
  }

  // RPC returns array, get first row
  const result = Array.isArray(data) ? data[0] : data;

  return {
    allowed: result?.allowed ?? false,
    reason: result?.reason ?? 'Unknown error',
    daily_used: result?.daily_used ?? 0,
    daily_limit: result?.daily_limit ?? 0,
    monthly_used: result?.monthly_used ?? 0,
    monthly_limit: result?.monthly_limit ?? 0,
  };
}

/**
 * Enhanced quota check with seconds tracking and tier-based limits.
 * This is the v2 quota system that tracks audio duration instead of just characters.
 */
export async function canSynthesizeV2(
  userId: string,
  characters: number,
  estimatedSeconds?: number
): Promise<EnhancedQuotaResult> {
  // Get user's tier
  const tier = await getUserTier(userId);
  const tierLimits = TIER_LIMITS[tier] || TIER_LIMITS.free;

  // For unlimited tier, always allow
  if (tier === 'unlimited') {
    return {
      allowed: true,
      reason: null,
      daily_used: 0,
      daily_limit: 999_999_999,
      monthly_used: 0,
      monthly_limit: 999_999_999,
      daily_seconds_used: 0,
      daily_seconds_limit: tierLimits.daily_seconds,
      monthly_seconds_used: 0,
      monthly_seconds_limit: tierLimits.monthly_seconds,
      priority: tierLimits.priority,
      tier,
      max_chars_per_job: tierLimits.max_chars_per_job,
    };
  }

  // Check max chars per job
  if (characters > tierLimits.max_chars_per_job) {
    return {
      allowed: false,
      reason: `Text too long. Maximum ${tierLimits.max_chars_per_job.toLocaleString()} characters per job for ${tier} tier.`,
      daily_used: 0,
      daily_limit: tierLimits.max_chars_per_job,
      monthly_used: 0,
      monthly_limit: tierLimits.max_chars_per_job,
      daily_seconds_used: 0,
      daily_seconds_limit: tierLimits.daily_seconds,
      monthly_seconds_used: 0,
      monthly_seconds_limit: tierLimits.monthly_seconds,
      priority: tierLimits.priority,
      tier,
      max_chars_per_job: tierLimits.max_chars_per_job,
    };
  }

  // Estimate seconds if not provided
  const estSeconds = estimatedSeconds ?? Math.ceil(characters / CHARS_PER_SECOND);

  // Try the v2 RPC function if available
  try {
    const { data, error } = await supabase.rpc('can_synthesize_v2', {
      p_user_id: userId,
      p_characters: characters,
      p_estimated_seconds: estSeconds,
    });

    if (error) {
      // Fall back to v1 if v2 doesn't exist
      if (error.code === '42883') {  // Function doesn't exist
        logger.warn('can_synthesize_v2 not found, falling back to v1');
        const v1Result = await canSynthesize(userId, characters);
        return {
          ...v1Result,
          daily_seconds_used: Math.ceil(v1Result.daily_used / CHARS_PER_SECOND),
          daily_seconds_limit: tierLimits.daily_seconds,
          monthly_seconds_used: Math.ceil(v1Result.monthly_used / CHARS_PER_SECOND),
          monthly_seconds_limit: tierLimits.monthly_seconds,
          priority: tierLimits.priority,
          tier,
          max_chars_per_job: tierLimits.max_chars_per_job,
        };
      }
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;

    return {
      allowed: result?.allowed ?? false,
      reason: result?.reason ?? 'Unknown error',
      daily_used: result?.daily_chars_used ?? 0,
      daily_limit: result?.daily_chars_limit ?? tierLimits.max_chars_per_job,
      monthly_used: result?.monthly_chars_used ?? 0,
      monthly_limit: result?.monthly_chars_limit ?? tierLimits.max_chars_per_job,
      daily_seconds_used: result?.daily_seconds_used ?? 0,
      daily_seconds_limit: result?.daily_seconds_limit ?? tierLimits.daily_seconds,
      monthly_seconds_used: result?.monthly_seconds_used ?? 0,
      monthly_seconds_limit: result?.monthly_seconds_limit ?? tierLimits.monthly_seconds,
      priority: result?.priority ?? tierLimits.priority,
      tier,
      max_chars_per_job: tierLimits.max_chars_per_job,
    };
  } catch (error) {
    logger.error({ error, userId, characters }, 'Failed to check quota v2');
    throw error;
  }
}

/**
 * Update usage with actual audio duration after synthesis.
 * Call this when actual duration differs from estimate.
 */
export async function updateActualSeconds(
  userId: string,
  estimatedSeconds: number,
  actualSeconds: number
): Promise<void> {
  if (estimatedSeconds === actualSeconds) return;

  try {
    const { error } = await supabase.rpc('update_usage_actual_seconds', {
      p_user_id: userId,
      p_estimated_seconds: estimatedSeconds,
      p_actual_seconds: actualSeconds,
    });

    if (error) {
      // Non-critical - log but don't throw
      logger.warn({ error, userId, estimatedSeconds, actualSeconds }, 'Failed to update actual seconds');
    }
  } catch (err) {
    logger.warn({ err, userId }, 'Exception updating actual seconds');
  }
}

/**
 * Get current daily quota for user.
 */
export async function getDailyQuota(userId: string): Promise<DBDailyQuota | null> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const { data, error } = await supabase
    .from('daily_quota')
    .select('*')
    .eq('user_id', userId)
    .eq('date', today)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error({ error, userId }, 'Failed to get daily quota');
    throw error;
  }

  return data;
}

/**
 * Get current monthly quota for user.
 */
export async function getMonthlyQuota(userId: string): Promise<DBMonthlyQuota | null> {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM

  const { data, error } = await supabase
    .from('monthly_quota')
    .select('*')
    .eq('user_id', userId)
    .eq('month', month)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error({ error, userId }, 'Failed to get monthly quota');
    throw error;
  }

  return data;
}

// ============================================================================
// Usage Logging
// ============================================================================

/**
 * Log a TTS usage record.
 */
export async function logTTSUsage(
  usage: Omit<DBTTSUsage, 'id' | 'created_at'>
): Promise<void> {
  // Skip logging for default users (no real user record)
  if (usage.user_id === 'pro-user-default' || usage.user_id === 'dev-user-001') {
    logger.info({ usage }, 'Skipping usage log for default user');
    return;
  }

  const { error } = await supabase.from('tts_usage').insert(usage);

  if (error) {
    logger.error({ error, usage }, 'Failed to log TTS usage');
    throw error;
  }
}

/**
 * Get recent usage for a user.
 */
export async function getRecentUsage(
  userId: string,
  limit = 50
): Promise<DBTTSUsage[]> {
  const { data, error } = await supabase
    .from('tts_usage')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, userId }, 'Failed to get recent usage');
    throw error;
  }

  return data ?? [];
}

// ============================================================================
// Audio Storage Operations
// ============================================================================

const AUDIO_BUCKET = 'audio-files';

/**
 * Upload synthesized audio to Supabase Storage.
 * Files are stored under: {userId}/{articleId}.{ext}
 */
export async function uploadAudio(
  userId: string,
  articleId: string,
  audioBuffer: Buffer,
  mimeType: string = 'audio/mpeg'
): Promise<string> {
  const extension = mimeType === 'audio/mpeg' ? 'mp3' : 'm4a';
  const filePath = `${userId}/${articleId}.${extension}`;

  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(filePath, audioBuffer, {
      contentType: mimeType,
      upsert: true,
    });

  if (error) {
    logger.error({ error, userId, articleId }, 'Failed to upload audio');
    throw error;
  }

  logger.info({ userId, articleId, filePath }, 'Audio uploaded to storage');
  return filePath;
}

/**
 * Get a signed URL for downloading audio from storage.
 * URL is valid for 1 hour.
 */
export async function getAudioDownloadURL(
  userId: string,
  articleId: string,
  extension: string = 'mp3'
): Promise<string | null> {
  const filePath = `${userId}/${articleId}.${extension}`;

  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(filePath, 3600); // 1 hour

  if (error) {
    if (error.message.includes('not found')) {
      return null;
    }
    logger.error({ error, userId, articleId }, 'Failed to get audio download URL');
    throw error;
  }

  return data?.signedUrl ?? null;
}

/**
 * Check if audio exists in storage.
 */
export async function audioExists(
  userId: string,
  articleId: string
): Promise<{ exists: boolean; extension?: string }> {
  const extensions = ['mp3', 'm4a', 'aac'];

  for (const ext of extensions) {
    const filePath = `${userId}/${articleId}.${ext}`;
    const { data } = await supabase.storage
      .from(AUDIO_BUCKET)
      .list(userId, {
        search: `${articleId}.${ext}`,
      });

    if (data && data.length > 0) {
      return { exists: true, extension: ext };
    }
  }

  return { exists: false };
}

/**
 * Delete audio from storage.
 */
export async function deleteAudio(
  userId: string,
  articleId: string
): Promise<void> {
  const { exists, extension } = await audioExists(userId, articleId);

  if (!exists || !extension) {
    return;
  }

  const filePath = `${userId}/${articleId}.${extension}`;

  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .remove([filePath]);

  if (error) {
    logger.error({ error, userId, articleId }, 'Failed to delete audio');
    throw error;
  }

  logger.info({ userId, articleId }, 'Audio deleted from storage');
}

// ============================================================================
// Latency Tracking Operations
// ============================================================================

/**
 * Text length buckets for latency caching.
 */
const LATENCY_BUCKETS = [
  { id: '0-500', min: 0, max: 500 },
  { id: '501-1000', min: 501, max: 1000 },
  { id: '1001-2500', min: 1001, max: 2500 },
  { id: '2501-5000', min: 2501, max: 5000 },
  { id: '5001-10000', min: 5001, max: 10000 },
  { id: '10001+', min: 10001, max: 999999999 },
];

/**
 * Get bucket for a given text length.
 */
export function getBucketForLength(textLength: number): { id: string; min: number; max: number } {
  const bucket = LATENCY_BUCKETS.find(b => textLength >= b.min && textLength <= b.max);
  // Always return a bucket - fallback to the last bucket (10001+) if not found
  return bucket ?? { id: '10001+', min: 10001, max: 999999999 };
}

/**
 * Record a latency metric from the iOS client.
 */
export async function recordLatencyMetric(
  metric: Omit<DBLatencyMetric, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await supabase.from('latency_metrics').insert(metric);

  if (error) {
    // Don't throw - latency tracking is non-critical
    logger.warn({ error, metric }, 'Failed to record latency metric');
    return;
  }

  logger.info({ textLength: metric.text_length, latencyMs: metric.latency_ms }, 'Latency metric recorded');
}

/**
 * Get cached latency estimate for a text length.
 * Returns null if no cache entry exists.
 */
export async function getLatencyCache(textLength: number): Promise<DBLatencyCache | null> {
  const bucket = getBucketForLength(textLength);

  const { data, error } = await supabase
    .from('latency_cache')
    .select('*')
    .eq('bucket_id', bucket.id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.warn({ error, bucket: bucket.id }, 'Failed to get latency cache');
    return null;
  }

  return data;
}

/**
 * Get all latency cache entries.
 */
export async function getAllLatencyCache(): Promise<DBLatencyCache[]> {
  const { data, error } = await supabase
    .from('latency_cache')
    .select('*')
    .order('min_length', { ascending: true });

  if (error) {
    logger.warn({ error }, 'Failed to get all latency cache');
    return [];
  }

  return data ?? [];
}

/**
 * Update or insert latency cache for a bucket.
 */
export async function upsertLatencyCache(cache: DBLatencyCache): Promise<void> {
  const { error } = await supabase
    .from('latency_cache')
    .upsert(cache, { onConflict: 'bucket_id' });

  if (error) {
    logger.warn({ error, bucket: cache.bucket_id }, 'Failed to upsert latency cache');
  }
}

/**
 * Aggregate latency metrics and update cache.
 * This calculates avg, p50, p95 for each bucket from recent data.
 */
export async function aggregateLatencyMetrics(): Promise<void> {
  logger.info('Starting latency metrics aggregation');

  for (const bucket of LATENCY_BUCKETS) {
    // Get recent metrics for this bucket (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: metrics, error } = await supabase
      .from('latency_metrics')
      .select('latency_ms')
      .gte('text_length', bucket.min)
      .lte('text_length', bucket.max)
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('latency_ms', { ascending: true });

    if (error) {
      logger.warn({ error, bucket: bucket.id }, 'Failed to fetch metrics for aggregation');
      continue;
    }

    if (!metrics || metrics.length === 0) {
      logger.info({ bucket: bucket.id }, 'No metrics for bucket, skipping');
      continue;
    }

    // Calculate statistics
    const latencies = metrics.map(m => m.latency_ms);
    const sum = latencies.reduce((a, b) => a + b, 0);
    const avg = Math.round(sum / latencies.length);
    const p50Index = Math.floor(latencies.length * 0.5);
    const p95Index = Math.floor(latencies.length * 0.95);
    const p50 = latencies[p50Index] ?? avg;
    const p95 = latencies[p95Index] ?? avg;

    const cacheEntry: DBLatencyCache = {
      bucket_id: bucket.id,
      min_length: bucket.min,
      max_length: bucket.max,
      avg_latency_ms: avg,
      p50_latency_ms: p50,
      p95_latency_ms: p95,
      sample_count: latencies.length,
      updated_at: new Date().toISOString(),
    };

    await upsertLatencyCache(cacheEntry);
    logger.info({ bucket: bucket.id, avg, p50, p95, sampleCount: latencies.length }, 'Updated latency cache');
  }

  logger.info('Latency metrics aggregation completed');
}

/**
 * Default latency estimates (ms) per bucket when no data available.
 * Based on typical Kokoro TTS performance.
 */
const DEFAULT_LATENCY_ESTIMATES: Record<string, number> = {
  '0-500': 2000,      // 2 seconds
  '501-1000': 3500,   // 3.5 seconds
  '1001-2500': 6000,  // 6 seconds
  '2501-5000': 10000, // 10 seconds
  '5001-10000': 18000, // 18 seconds
  '10001+': 30000,    // 30 seconds
};

/**
 * Get estimated latency for a given text length.
 * Uses cached data if available, otherwise returns default estimates.
 */
export async function getLatencyEstimate(textLength: number): Promise<{
  estimated_seconds: number;
  confidence: 'high' | 'medium' | 'low';
  bucket: string;
  sample_count: number;
}> {
  const bucket = getBucketForLength(textLength);
  const cached = await getLatencyCache(textLength);

  if (cached && cached.sample_count >= 10) {
    // High confidence: 10+ samples
    return {
      estimated_seconds: Math.round(cached.p50_latency_ms / 1000),
      confidence: 'high',
      bucket: bucket.id,
      sample_count: cached.sample_count,
    };
  }

  if (cached && cached.sample_count >= 3) {
    // Medium confidence: 3-9 samples
    return {
      estimated_seconds: Math.round(cached.avg_latency_ms / 1000),
      confidence: 'medium',
      bucket: bucket.id,
      sample_count: cached.sample_count,
    };
  }

  // Low confidence: use defaults
  const defaultMs = DEFAULT_LATENCY_ESTIMATES[bucket.id] ?? 5000;
  return {
    estimated_seconds: Math.round(defaultMs / 1000),
    confidence: 'low',
    bucket: bucket.id,
    sample_count: cached?.sample_count ?? 0,
  };
}

// ============================================================================
// TTS Job Operations
// ============================================================================

// Re-export rollout functions for backward compatibility
// The actual implementation is in rollout.ts
export {
  isUserAllowlistedForJobApi,
  addUserToJobApiAllowlist,
} from './rollout.js';

/**
 * Check if cached audio exists for a given cache key.
 * Uses the database function that also updates hit count.
 */
export async function getCachedAudio(cacheKey: string): Promise<{
  audioPath: string;
  durationSec: number;
  format: AudioFormat;
  hits: number;
} | null> {
  const { data, error } = await supabase.rpc('get_cached_audio', {
    p_cache_key: cacheKey,
  });

  if (error) {
    logger.error({ error, cacheKey }, 'Failed to check cache');
    return null;
  }

  // RPC returns array
  const result = Array.isArray(data) ? data[0] : data;

  if (!result || !result.audio_path) {
    return null;
  }

  return {
    audioPath: result.audio_path,
    durationSec: result.duration_sec,
    format: result.format,
    hits: result.hit_count,
  };
}

/**
 * Create or update a cache entry.
 */
export async function upsertCacheEntry(params: {
  cacheKey: string;
  audioPath: string;
  format: AudioFormat;
  durationSec: number;
  fileSizeBytes: number | null;
  voiceId: string;
  modelId: string;
  speed: number;
  textHash: string;
}): Promise<void> {
  const { error } = await supabase.rpc('upsert_cache_entry', {
    p_cache_key: params.cacheKey,
    p_audio_path: params.audioPath,
    p_format: params.format,
    p_duration_sec: params.durationSec,
    p_file_size_bytes: params.fileSizeBytes,
    p_voice_id: params.voiceId,
    p_model_id: params.modelId,
    p_speed: params.speed,
    p_text_hash: params.textHash,
  });

  if (error) {
    logger.error({ error, cacheKey: params.cacheKey }, 'Failed to upsert cache entry');
    throw error;
  }
}

/**
 * Create a new TTS job.
 * Uses RPC to bypass PostgREST schema cache issues.
 * Also stores the text temporarily for worker processing.
 */
export async function createTTSJob(params: {
  userId: string;
  voiceId: string;
  modelId: string;
  speed: number;
  format: AudioFormat;
  inputTextHash: string | null;
  inputCharCount: number;
  cacheKey: string;
  text: string;  // Text to synthesize (stored temporarily)
  articleId?: string;
  articleTitle?: string;
  // Cloned voice fields (optional)
  clonedVoiceId?: string;
  voiceUrl?: string;
  cloningModel?: 'chatterbox' | 'xtts';
}): Promise<DBTTSJob> {
  // Create the job via RPC (bypasses PostgREST table cache)
  const { data: jobId, error } = await supabase.rpc('create_tts_job', {
    p_user_id: params.userId,
    p_voice_id: params.voiceId,
    p_model_id: params.modelId,
    p_speed: params.speed,
    p_format: params.format,
    p_input_text_hash: params.inputTextHash,
    p_input_char_count: params.inputCharCount,
    p_cache_key: params.cacheKey,
    p_text: params.text,
    p_article_id: params.articleId ?? null,
    p_article_title: params.articleTitle ?? null,
    // Cloned voice fields
    p_cloned_voice_id: params.clonedVoiceId ?? null,
    p_voice_url: params.voiceUrl ?? null,
    p_cloning_model: params.cloningModel ?? null,
  });

  if (error) {
    logger.error({ error, userId: params.userId }, 'Failed to create TTS job');
    throw error;
  }

  const isClonedVoice = !!params.clonedVoiceId;
  logger.info(
    { jobId, userId: params.userId, cacheKey: params.cacheKey, isClonedVoice, cloningModel: params.cloningModel },
    'TTS job created'
  );

  // Return a minimal job object with the ID
  return {
    id: jobId,
    user_id: params.userId,
    status: 'queued',
    voice_id: params.voiceId,
    model_id: params.modelId,
    speed: params.speed,
    format: params.format,
    input_text_hash: params.inputTextHash,
    input_char_count: params.inputCharCount,
    cache_key: params.cacheKey,
    audio_path: null,
    audio_url: null,
    audio_url_expires_at: null,
    duration_sec: null,
    progress_sec: 0,
    chunks_total: null,
    chunks_completed: 0,
    error_code: null,
    error_message: null,
    retry_count: 0,
    article_id: params.articleId ?? null,
    article_title: params.articleTitle ?? null,
    cloned_voice_id: params.clonedVoiceId ?? null,
    voice_url: params.voiceUrl ?? null,
    cloning_model: params.cloningModel ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
  } as DBTTSJob;
}

/**
 * Get a TTS job by ID.
 * Uses RPC to bypass PostgREST schema cache issues.
 */
export async function getTTSJob(jobId: string): Promise<DBTTSJob | null> {
  // Use RPC with a dummy user ID since we're not checking ownership
  const { data, error } = await supabase.rpc('get_tts_job', {
    p_job_id: jobId,
    p_user_id: '00000000-0000-0000-0000-000000000000', // Dummy - function ignores for admin access
  });

  if (error) {
    logger.error({ error, jobId }, 'Failed to get TTS job');
    throw error;
  }

  if (!data || (Array.isArray(data) && data.length === 0)) {
    return null;
  }

  const row = Array.isArray(data) ? data[0] : data;
  return row as DBTTSJob;
}

/**
 * Get a TTS job by ID, verifying user ownership.
 * Uses direct query to get all columns including preview audio fields.
 */
export async function getTTSJobForUser(jobId: string, userId: string): Promise<DBTTSJob | null> {
  const { data, error } = await supabase
    .from('tts_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      return null;
    }
    logger.error({ error, jobId, userId }, 'Failed to get TTS job for user');
    throw error;
  }

  return data as DBTTSJob;
}

/**
 * Update TTS job status and progress.
 */
export async function updateTTSJobProgress(params: {
  jobId: string;
  status: TTSJobStatus;
  progressSec?: number;
  chunksCompleted?: number;
  audioPath?: string;
  durationSec?: number;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  const { error } = await supabase.rpc('update_job_progress', {
    p_job_id: params.jobId,
    p_status: params.status,
    p_progress_sec: params.progressSec ?? null,
    p_chunks_completed: params.chunksCompleted ?? null,
    p_audio_path: params.audioPath ?? null,
    p_duration_sec: params.durationSec ?? null,
    p_error_code: params.errorCode ?? null,
    p_error_message: params.errorMessage ?? null,
  });

  if (error) {
    logger.error({ error, jobId: params.jobId }, 'Failed to update job progress');
    throw error;
  }
}

/**
 * Check if there's an existing job with the same cache key that's ready.
 * Returns the job if found, null otherwise.
 */
export async function findReadyJobByCacheKey(cacheKey: string): Promise<DBTTSJob | null> {
  const { data, error } = await supabase
    .from('tts_jobs')
    .select('*')
    .eq('cache_key', cacheKey)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    logger.warn({ error, cacheKey }, 'Error finding ready job by cache key');
    return null;
  }

  return data;
}

/**
 * Get a signed URL for an audio file in storage.
 * URL is valid for 1 hour.
 */
export async function getSignedAudioUrl(audioPath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrl(audioPath, 3600); // 1 hour

  if (error) {
    logger.error({ error, audioPath }, 'Failed to create signed URL');
    return null;
  }

  return data?.signedUrl ?? null;
}

/**
 * Upload audio buffer to storage and return the path.
 */
export async function uploadAudioToCache(
  audioPath: string,
  audioBuffer: Buffer,
  format: AudioFormat
): Promise<void> {
  const contentType = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  }[format];

  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(audioPath, audioBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    logger.error({ error, audioPath }, 'Failed to upload audio to cache');
    throw error;
  }

  logger.info({ audioPath, size: audioBuffer.length }, 'Audio uploaded to cache');
}

/**
 * Upload audio from a local file path to storage.
 * Reads the file and uploads it - useful when audio was streamed directly to disk.
 */
export async function uploadAudioFromFile(
  storagePath: string,
  localFilePath: string,
  format: AudioFormat
): Promise<{ size: number }> {
  const fs = await import('fs/promises');

  const contentType = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  }[format];

  // Read file into buffer for upload
  const audioBuffer = await fs.readFile(localFilePath);

  const { error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(storagePath, audioBuffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    logger.error({ error, storagePath, localFilePath }, 'Failed to upload audio from file');
    throw error;
  }

  logger.info({ storagePath, localFilePath, size: audioBuffer.length }, 'Audio uploaded from file');

  return { size: audioBuffer.length };
}

/**
 * Get user's recent TTS jobs.
 */
export async function getUserTTSJobs(userId: string, limit = 20): Promise<DBTTSJob[]> {
  const { data, error } = await supabase
    .from('tts_jobs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ error, userId }, 'Failed to get user TTS jobs');
    throw error;
  }

  return data ?? [];
}

// ============================================================================
// Health Check & Diagnostics
// ============================================================================

/**
 * Check Supabase connectivity with a lightweight query.
 * Returns connection status and latency.
 */
export async function checkSupabaseHealth(): Promise<{
  connected: boolean;
  latencyMs: number;
  diagnostics: ReturnType<typeof getConnectionDiagnostics>;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    // Simple query to check connectivity
    const { error } = await supabase
      .from('voices')
      .select('id')
      .limit(1);

    const latencyMs = Date.now() - startTime;

    if (error) {
      return {
        connected: false,
        latencyMs,
        diagnostics: getConnectionDiagnostics(),
        error: error.message,
      };
    }

    return {
      connected: true,
      latencyMs,
      diagnostics: getConnectionDiagnostics(),
    };
  } catch (error) {
    return {
      connected: false,
      latencyMs: Date.now() - startTime,
      diagnostics: getConnectionDiagnostics(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Cloned Voices Operations
// ============================================================================

import type { DBClonedVoice } from '../types/index.js';

const CLONED_VOICES_BUCKET = 'cloned-voices';

/**
 * Create a new cloned voice record.
 * Returns the created voice and a signed upload URL for the reference audio.
 */
export async function createClonedVoice(params: {
  userId: string;
  name: string;
  description?: string;
  exaggeration?: number;
}): Promise<{ voice: DBClonedVoice; uploadUrl: string; expiresAt: Date }> {
  // Generate a unique ID for the voice
  const voiceId = crypto.randomUUID();
  const audioPath = `${params.userId}/${voiceId}.wav`;

  // Insert the voice record
  const { data, error } = await supabase
    .from('cloned_voices')
    .insert({
      id: voiceId,
      user_id: params.userId,
      name: params.name,
      description: params.description ?? null,
      audio_path: audioPath,
      exaggeration: params.exaggeration ?? 0.5,
    })
    .select()
    .single();

  if (error) {
    logger.error({ error, userId: params.userId }, 'Failed to create cloned voice');
    throw error;
  }

  // Create a signed upload URL (valid for 10 minutes)
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from(CLONED_VOICES_BUCKET)
    .createSignedUploadUrl(audioPath);

  if (uploadError) {
    // Rollback the voice record
    await supabase.from('cloned_voices').delete().eq('id', voiceId);
    logger.error({ error: uploadError, userId: params.userId }, 'Failed to create upload URL');
    throw uploadError;
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  logger.info({ voiceId, userId: params.userId, name: params.name }, 'Cloned voice created');

  return {
    voice: data as DBClonedVoice,
    uploadUrl: uploadData.signedUrl,
    expiresAt,
  };
}

/**
 * Confirm that a cloned voice's audio has been uploaded.
 * Updates the voice record with audio metadata.
 */
export async function confirmClonedVoiceUpload(params: {
  voiceId: string;
  userId: string;
  durationSec: number;
  fileSizeBytes: number;
}): Promise<DBClonedVoice> {
  const { data, error } = await supabase
    .from('cloned_voices')
    .update({
      duration_sec: params.durationSec,
      file_size_bytes: params.fileSizeBytes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.voiceId)
    .eq('user_id', params.userId)
    .select()
    .single();

  if (error) {
    logger.error({ error, voiceId: params.voiceId }, 'Failed to confirm voice upload');
    throw error;
  }

  logger.info({ voiceId: params.voiceId, durationSec: params.durationSec }, 'Cloned voice upload confirmed');

  return data as DBClonedVoice;
}

/**
 * Get user's cloned voices.
 */
export async function getUserClonedVoices(userId: string): Promise<DBClonedVoice[]> {
  const { data, error } = await supabase
    .from('cloned_voices')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('usage_count', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ error, userId }, 'Failed to get user cloned voices');
    throw error;
  }

  return data ?? [];
}

/**
 * Get a specific cloned voice by ID.
 */
export async function getClonedVoice(voiceId: string, userId: string): Promise<DBClonedVoice | null> {
  const { data, error } = await supabase
    .from('cloned_voices')
    .select('*')
    .eq('id', voiceId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error({ error, voiceId }, 'Failed to get cloned voice');
    throw error;
  }

  return data as DBClonedVoice;
}

/**
 * Get a signed URL for a cloned voice's reference audio.
 */
export async function getClonedVoiceAudioUrl(audioPath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(CLONED_VOICES_BUCKET)
    .createSignedUrl(audioPath, 3600); // 1 hour

  if (error) {
    logger.error({ error, audioPath }, 'Failed to create signed URL for cloned voice');
    return null;
  }

  return data?.signedUrl ?? null;
}

/**
 * Update a cloned voice.
 */
export async function updateClonedVoice(
  voiceId: string,
  userId: string,
  updates: Partial<Pick<DBClonedVoice, 'name' | 'description' | 'exaggeration' | 'is_default'>>
): Promise<DBClonedVoice> {
  // If setting as default, first unset other defaults
  if (updates.is_default) {
    await supabase
      .from('cloned_voices')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_default', true);
  }

  const { data, error } = await supabase
    .from('cloned_voices')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', voiceId)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    logger.error({ error, voiceId }, 'Failed to update cloned voice');
    throw error;
  }

  return data as DBClonedVoice;
}

/**
 * Delete a cloned voice (soft delete).
 */
export async function deleteClonedVoice(voiceId: string, userId: string): Promise<void> {
  // Soft delete - mark as inactive
  const { error } = await supabase
    .from('cloned_voices')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', voiceId)
    .eq('user_id', userId);

  if (error) {
    logger.error({ error, voiceId }, 'Failed to delete cloned voice');
    throw error;
  }

  // Note: We don't delete the audio file immediately - could be used for recovery
  // or cleaned up by a background job later

  logger.info({ voiceId, userId }, 'Cloned voice deleted (soft)');
}

/**
 * Record usage of a cloned voice.
 */
export async function recordClonedVoiceUsage(voiceId: string): Promise<void> {
  const { error } = await supabase.rpc('record_cloned_voice_usage', {
    p_voice_id: voiceId,
  });

  if (error) {
    // Non-critical - log but don't throw
    logger.warn({ error, voiceId }, 'Failed to record cloned voice usage');
  }
}

/**
 * Check Supabase Storage connectivity.
 */
export async function checkStorageHealth(): Promise<{
  connected: boolean;
  latencyMs: number;
  error?: string;
}> {
  const startTime = Date.now();

  try {
    // Try to list files in the audio bucket (lightweight operation)
    const { error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .list('', { limit: 1 });

    const latencyMs = Date.now() - startTime;

    if (error) {
      return {
        connected: false,
        latencyMs,
        error: error.message,
      };
    }

    return {
      connected: true,
      latencyMs,
    };
  } catch (error) {
    return {
      connected: false,
      latencyMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
