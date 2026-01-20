import type { Request } from 'express';

// ============================================================================
// Environment Configuration
// ============================================================================

export interface EnvConfig {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SUPABASE_JWT_SECRET: string;
  OPENAI_API_KEY?: string;
  SELFHOSTED_TTS_URL?: string;
  SELFHOSTED_TTS_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  TTS_PROVIDER?: 'elevenlabs' | 'selfhosted' | 'mock';
  GPU_TTS_URL?: string;
  GPU_TTS_ENABLED: boolean;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
}

// ============================================================================
// Authentication
// ============================================================================

export interface JWTPayload {
  sub: string;          // User ID
  email?: string;
  aud: string;          // Audience
  exp: number;          // Expiration timestamp
  iat: number;          // Issued at timestamp
  role?: string;        // User role
  app_metadata?: {
    provider?: string;
  };
  user_metadata?: {
    full_name?: string;
    avatar_url?: string;
  };
}

export interface AuthenticatedUser {
  id: string;
  email?: string;
  role?: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

// ============================================================================
// Database Types (matching Supabase schema)
// ============================================================================

export type SubscriptionTier = 'free' | 'basic' | 'pro' | 'unlimited';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired';
export type TTSProvider = 'selfhosted' | 'elevenlabs' | 'mock';

export interface DBUser {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  preferred_voice_id: string | null;
  default_playback_speed: number;
  has_completed_onboarding: boolean;
  created_at: string;
  updated_at: string;
}

export interface DBSubscription {
  id: string;
  user_id: string;
  plan_id: SubscriptionTier;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  renews_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DBVoice {
  id: string;
  name: string;
  description: string | null;
  style: string;
  category: string;
  provider: TTSProvider;
  provider_voice_id: string;
  provider_model_id: string | null;
  language: string;
  gender: 'male' | 'female' | 'neutral' | null;
  is_premium: boolean;
  tier_required: SubscriptionTier;
  settings: Record<string, unknown>;
  sample_audio_url: string | null;
  sample_text: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DBTTSUsage {
  id: string;
  user_id: string;
  voice_id: string | null;
  provider: TTSProvider;
  provider_voice_id: string;
  characters_used: number;
  audio_duration_ms: number | null;
  estimated_cost_usd: number | null;
  article_id: string | null;
  article_title: string | null;
  success: boolean;
  error_code: string | null;
  error_message: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface DBMonthlyQuota {
  user_id: string;
  month: string;
  char_limit: number;
  char_used: number;
  request_count: number;
  created_at: string;
  updated_at: string;
}

export interface DBDailyQuota {
  user_id: string;
  date: string;
  char_limit: number;
  char_used: number;
  request_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

// POST /tts
export interface TTSRequestBody {
  text: string;
  voice_id: string;  // Kokoro ID (e.g., 'am_adam')
  options?: {
    speed?: number;
    format?: 'mp3' | 'wav' | 'ogg';
  };
  article_id?: string;
  article_title?: string;
}

export interface TTSErrorResponse {
  error: string;
  message: string;
  quota?: {
    daily_used: number;
    daily_limit: number;
    monthly_used: number;
    monthly_limit: number;
    resets_at: string;
  };
  required_tier?: SubscriptionTier;
  current_tier?: SubscriptionTier;
}

// GET /usage (simplified response)
export interface UsageSummaryResponse {
  current_month: string;
  char_used: number;
  char_limit: number;
}

// GET /usage/full (detailed response)
export interface UsageResponse {
  subscription: {
    tier: SubscriptionTier;
    status: SubscriptionStatus;
    current_period_end: string | null;
  };
  usage: {
    daily: QuotaInfo;
    monthly: QuotaInfo;
  };
  estimated_minutes_remaining: number;
}

export interface QuotaInfo {
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  resets_at: string;
}

// GET /voices (simplified public response)
export interface VoiceListItem {
  id: string;
  name: string;
  is_premium: boolean;
  hint: string;
}

export interface VoiceListResponse {
  voices: VoiceListItem[];
}

// GET /voices/full (authenticated detailed response)
export interface VoicesResponse {
  voices: VoiceInfo[];
  user_tier: SubscriptionTier;
}

export interface VoiceInfo {
  id: string;
  name: string;
  description: string | null;
  provider: TTSProvider;
  category: string;
  style: string;
  language: string;
  gender: string | null;
  tier_required: SubscriptionTier;
  is_premium: boolean;
  sample_audio_url: string | null;
  is_available: boolean;
}

// GET /voices/:id
export interface VoiceDetailResponse extends VoiceInfo {
  provider_voice_id: string;
  provider_model_id: string | null;
  supported_languages: string[];
  settings: Record<string, unknown>;
  sample_text: string;
}

// ============================================================================
// TTS Provider Types
// ============================================================================

export interface TTSProviderRequest {
  text: string;
  voiceId: string;
  modelId?: string;
  settings?: Record<string, unknown>;
  format?: 'mp3' | 'wav' | 'ogg';
  speed?: number;
}

export interface TTSProviderResponse {
  audioBuffer: Buffer;
  durationMs?: number;
  format: string;
}

// ============================================================================
// Quota Check Types
// ============================================================================

export interface QuotaCheckResult {
  allowed: boolean;
  reason: string | null;
  daily_used: number;
  daily_limit: number;
  monthly_used: number;
  monthly_limit: number;
  // Optional seconds tracking (from v2 quota system)
  daily_seconds_used?: number;
  daily_seconds_limit?: number;
  monthly_seconds_used?: number;
  monthly_seconds_limit?: number;
}

// ============================================================================
// Error Types
// ============================================================================

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions', details?: Record<string, unknown>) {
    super(403, 'FORBIDDEN', message, details);
    this.name = 'AuthorizationError';
  }
}

export class QuotaExceededError extends AppError {
  constructor(message: string, quota: QuotaCheckResult) {
    // Include seconds tracking if available (from v2 quota system)
    // The iOS client uses seconds for quota display
    const details: Record<string, unknown> = {
      daily_used: quota.daily_seconds_used ?? quota.daily_used,
      daily_limit: quota.daily_seconds_limit ?? quota.daily_limit,
      monthly_used: quota.monthly_seconds_used ?? quota.monthly_used,
      monthly_limit: quota.monthly_seconds_limit ?? quota.monthly_limit,
    };
    super(402, 'QUOTA_EXCEEDED', message, details);
    this.name = 'QuotaExceededError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class TTSProviderError extends AppError {
  constructor(provider: string, message: string) {
    super(502, 'TTS_PROVIDER_ERROR', `${provider}: ${message}`);
    this.name = 'TTSProviderError';
  }
}

// ============================================================================
// Latency Tracking Types
// ============================================================================

/**
 * Latency metric recorded when iOS client completes audio playback.
 * Measures end-to-end time from request to first audio play.
 */
export interface DBLatencyMetric {
  id: string;
  user_id: string | null;
  text_length: number;
  latency_ms: number;
  provider: TTSProvider;
  voice_id: string | null;
  created_at: string;
}

/**
 * Cached latency estimates by text length bucket.
 * Buckets: 0-500, 501-1000, 1001-2500, 2501-5000, 5001-10000, 10001+
 */
export interface DBLatencyCache {
  bucket_id: string;  // e.g., '0-500', '501-1000'
  min_length: number;
  max_length: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  sample_count: number;
  updated_at: string;
}

export interface LatencyEstimateResponse {
  estimated_seconds: number;
  confidence: 'high' | 'medium' | 'low';
  bucket: string;
  sample_count: number;
}

// ============================================================================
// TTS Jobs and Cache Types
// ============================================================================

/**
 * TTS Job status enum (matches database enum)
 */
export type TTSJobStatus =
  | 'queued'           // Job created, waiting to be processed
  | 'processing'       // Currently being synthesized
  | 'partial_ready'    // Some chunks ready, streaming possible
  | 'ready'            // Fully synthesized, audio available
  | 'failed'           // Synthesis failed
  | 'canceled';        // User canceled the job

/**
 * Audio format enum
 */
export type AudioFormat = 'wav' | 'mp3' | 'ogg';

/**
 * TTS Job record (matches tts_jobs table)
 */
export interface DBTTSJob {
  id: string;
  user_id: string;
  status: TTSJobStatus;

  // Voice configuration
  voice_id: string;
  model_id: string;
  speed: number;
  format: AudioFormat;

  // Input metadata
  input_text_hash: string | null;
  input_char_count: number;
  cache_key: string;

  // Output audio
  audio_path: string | null;
  audio_url: string | null;
  audio_url_expires_at: string | null;

  // Preview-first audio (Phase 5)
  preview_audio_path: string | null;
  preview_duration_sec: number | null;
  full_audio_path: string | null;

  // Progress tracking
  duration_sec: number | null;
  progress_sec: number;
  chunks_total: number | null;
  chunks_completed: number;

  // Error handling
  error_code: string | null;
  error_message: string | null;
  retry_count: number;

  // Article association
  article_id: string | null;
  article_title: string | null;

  // Timestamps
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/**
 * TTS Cache record (matches tts_cache table)
 */
export interface DBTTSCache {
  cache_key: string;
  audio_path: string;
  format: AudioFormat;
  duration_sec: number;
  file_size_bytes: number | null;
  voice_id: string;
  model_id: string;
  speed: number;
  hits: number;
  last_hit_at: string | null;
  created_at: string;
  text_hash: string;
}

/**
 * Request to create a TTS job
 */
export interface CreateTTSJobRequest {
  text: string;
  voice_id: string;
  model_id?: string;
  speed?: number;
  format?: AudioFormat;
  article_id?: string;
  article_title?: string;
}

/**
 * Response when creating a TTS job
 */
export interface CreateTTSJobResponse {
  job_id: string;
  status: TTSJobStatus;
  cache_hit: boolean;
  audio_url?: string;          // Present if cache hit or status is 'ready'
  estimated_wait_sec?: number; // Estimated time if queued
  preview_url?: string;        // Present if fast lane micro was generated (status is 'partial_ready')
  preview_duration_sec?: number; // Duration of preview in seconds
}

/**
 * Response when polling job status
 */
export interface TTSJobStatusResponse {
  job_id: string;
  status: TTSJobStatus;
  progress: {
    duration_sec: number | null;
    progress_sec: number;
    chunks_total: number | null;
    chunks_completed: number;
    percentage: number;
  };
  audio_url?: string;        // Full audio URL (when status is 'ready')
  preview_url?: string;      // Preview audio URL (when status is 'partial_ready' or 'ready')
  preview_duration_sec?: number;  // Duration of preview in seconds
  error?: {
    code: string;
    message: string;
  };
  created_at: string;
  updated_at: string;
}
