import { z } from 'zod';
import type { EnvConfig } from '../types/index.js';

// ============================================================================
// Environment Variable Schema
// ============================================================================

const envSchema = z.object({
  PORT: z.string().transform(Number).default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  // TTS Providers
  // OPENAI_API_KEY removed — listenai-backend's LLM calls (summarize +
  // article cleanup) now go through Anthropic. OpenAI billing is off.
  ANTHROPIC_API_KEY: z.string().optional(),
  SELFHOSTED_TTS_URL: z.string().url().optional(),
  SELFHOSTED_TTS_API_KEY: z.string().optional(),

  // ElevenLabs TTS (V1 Production)
  ELEVENLABS_API_KEY: z.string().optional(),

  // TTS Provider Selection: 'elevenlabs' | 'selfhosted' | 'mock'
  // Default: 'elevenlabs' if ELEVENLABS_API_KEY is set, otherwise 'selfhosted'
  TTS_PROVIDER: z.enum(['elevenlabs', 'selfhosted', 'mock']).optional(),

  // GPU TTS (primary, with CPU fallback) - legacy, not used when ElevenLabs configured
  GPU_TTS_URL: z.string().url().optional(),
  GPU_TTS_ENABLED: z.string().transform(v => v === 'true').default('false'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('60000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('60'),

  // Pub/Sub push auth secret (used by /api/tts/worker/push endpoint)
  PUBSUB_PUSH_SECRET: z.string().optional(),

  // realtime-tts-gateway (separate Fly app/repo) - lets signed-in users
  // generate an API key for the standalone realtime TTS service. Optional so
  // this repo still boots in envs where that feature isn't configured.
  TTS_GATEWAY_URL: z.string().url().default('https://realtime-tts-gateway.fly.dev'),
  TTS_GATEWAY_ADMIN_SECRET: z.string().optional(),

  // Voice studio (customer custom voices) - see routes/voiceStudio.ts. Ships dark: the feature is off
  // (routes return 404) unless VOICE_STUDIO_ENABLED_USERS lists Supabase user ids (comma separated) or "*".
  VOICE_STUDIO_ENABLED_USERS: z.string().default(''),
  VOICE_INTAKE_URL: z.string().url().default('https://t-sushanth--voice-intake-api.modal.run'),
  INTAKE_SECRET: z.string().optional(),
  VOICE_STUDIO_MAX_VOICES_PER_USER: z.string().transform(Number).default('3'),
  VOICE_STUDIO_MAX_ZIP_MB: z.string().transform(Number).default('300'),
});

// ============================================================================
// Configuration Loader
// ============================================================================

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

// ============================================================================
// Exported Configuration
// ============================================================================

export const config = loadConfig();

// ============================================================================
// Tier Limits Configuration
// ============================================================================

/**
 * Tier limits for TTS usage
 * - daily_seconds: Maximum audio output seconds per day
 * - monthly_seconds: Maximum audio output seconds per month
 * - max_chars_per_job: Maximum characters allowed in a single TTS job
 * - requests_per_minute: Rate limit for TTS requests
 * - priority: Queue priority (higher = processed first)
 * - quality: Audio quality settings
 */
export const TIER_LIMITS = {
  free: {
    daily_seconds: 1_800,         // 30 minutes per day
    monthly_seconds: 10_800,      // 3 hours per month
    max_chars_per_job: 25_000,    // ~30 minutes max per job
    requests_per_minute: 10,      // Moderate rate limit
    priority: 0,                  // Lowest priority
    quality: 'standard',          // Standard audio quality
  },
  basic: {
    daily_seconds: 1_800,         // 30 minutes per day
    monthly_seconds: 18_000,      // 5 hours per month
    max_chars_per_job: 25_000,    // ~30 minutes max per job
    requests_per_minute: 15,      // Moderate rate limit
    priority: 1,                  // Normal priority
    quality: 'standard',          // Standard audio quality
  },
  pro: {
    daily_seconds: 7_200,         // 2 hours per day
    monthly_seconds: 72_000,      // 20 hours per month
    max_chars_per_job: 100_000,   // ~2 hours max per job
    requests_per_minute: 30,      // Higher rate limit
    priority: 2,                  // High priority
    quality: 'high',              // High-quality audio
  },
  unlimited: {
    daily_seconds: 999_999,       // Effectively unlimited
    monthly_seconds: 999_999,     // Effectively unlimited
    max_chars_per_job: 500_000,   // ~10 hours max per job
    requests_per_minute: 60,      // Highest rate limit
    priority: 3,                  // Highest priority
    quality: 'high',              // High-quality audio
  },
} as const;

// Backward compatibility: Character-based limits (approximate)
// ~750 characters = 1 minute of audio
export const TIER_LIMITS_CHARS = {
  free: {
    daily: 22_500,     // ~30 minutes
    monthly: 135_000,  // ~3 hours
  },
  basic: {
    daily: 25_000,     // ~30 minutes
    monthly: 250_000,  // ~5 hours
  },
  pro: {
    daily: 100_000,    // ~2 hours
    monthly: 1_000_000, // ~20 hours
  },
  unlimited: {
    daily: 999_999_999,
    monthly: 999_999_999,
  },
} as const;

// Tier hierarchy for access control
export const TIER_HIERARCHY: Record<string, number> = {
  free: 0,
  basic: 1,
  pro: 2,
  unlimited: 3,
};

// Maximum text length per request (enforced at API level)
export const MAX_TEXT_LENGTH = 500_000;

// Preview text limit (doesn't count against quota)
export const PREVIEW_TEXT_LIMIT = 200;

// Conversion rate: characters to seconds
// Average speaking rate is ~150 words/min ≈ 750 chars/min ≈ 12.5 chars/sec
export const CHARS_PER_SECOND = 12.5;
