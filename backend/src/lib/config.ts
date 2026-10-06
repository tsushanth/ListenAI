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

  // Voice design (text-to-voice via Parler-TTS on Modal) — ships dark if unset.
  VOICE_DESIGN_URL: z.string().url().optional(),
  VOICE_DESIGN_SECRET: z.string().optional(),

  // Voice convert (speech-to-speech via Seed-VC on Modal) — ships dark if unset.
  VOICE_CONVERT_URL: z.string().url().optional(),
  VOICE_CONVERT_SECRET: z.string().optional(),

  // Voice isolate (vocal isolation via Demucs on Modal) — ships dark if unset.
  VOICE_ISOLATE_URL: z.string().url().optional(),
  VOICE_ISOLATE_SECRET: z.string().optional(),

  // XTTS v2 instant voice cloning — ships dark if unset.
  XTTS_CLONE_URL: z.string().url().optional(),
  XTTS_CLONE_SECRET: z.string().optional(),

  // Batch speech-to-text (worker-stt-prod, faster-whisper large-v3-turbo, external Modal app in the
  // rt-stt-rt-prod repo — shared, scale-to-zero, NOT a per-user deployment; see routes/stt.ts) — ships
  // dark if unset. Unlike XTTS/voice-convert, the worker is not called directly with a static bearer
  // secret: it requires a session token minted by the realtime-tts gateway's /stt/authorize, so these
  // are gateway-facing credentials (mirrors REALTIME_TTS_API_KEY/REALTIME_TTS_GATEWAY_URL in
  // routes/realtimeTts.ts), not a worker URL/secret pair.
  STT_GATEWAY_URL: z.string().url().optional(),
  STT_API_KEY: z.string().optional(),
  // STT API hardening (routes/stt.ts). All optional; defaults are conservative.
  //  - uploads stream to a temp file (never memory); STT_TMP_DIR defaults to <os tmpdir>/stt-uploads
  //  - limits are per API key (gateway key id) or per user, enforced in-process (see lib/sttLimits.ts)
  //  - retention: transcript text is NOT stored unless a retention period is set (default 0 = metadata only)
  STT_MAX_UPLOAD_MB: z.string().transform(Number).default('200'),
  STT_TMP_DIR: z.string().optional(),
  STT_RATE_LIMIT_PER_MIN: z.string().transform(Number).default('60'),
  STT_MAX_CONCURRENT_PER_KEY: z.string().transform(Number).default('4'),
  STT_MAX_CONCURRENT_GLOBAL: z.string().transform(Number).default('8'),
  STT_MAX_KEYTERMS: z.string().transform(Number).default('1000'),
  STT_KEYTERMS_MAX_QUERY_BYTES: z.string().transform(Number).default('7000'),
  // Minimum billed audio seconds per successful STT request (billing only; transcript/duration unchanged).
  // 0 disables. Applied once, inside reportSttUsage. Non-numeric or negative values fall back to 10.
  STT_MIN_BILLED_SECONDS: z.string().transform((v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 10; }).default('10'),
  STT_DEFAULT_RETENTION_DAYS: z.string().transform(Number).default('0'),
  STT_MAX_RETENTION_DAYS: z.string().transform(Number).default('30'),
  // Improved batch worker (Modal app ra-stt-shadow-w22; see routes/stt.ts). PERCENT 0 (default) = feature off:
  // nothing changes. The worker takes `Authorization: Bearer STT_IMPROVED_TOKEN` directly (no gateway authorize).
  STT_IMPROVED_URL: z.string().url().optional(),
  STT_IMPROVED_TOKEN: z.string().optional(),
  STT_IMPROVED_PERCENT: z.string().transform(Number).default('0'),
  STT_IMPROVED_TIMEOUT_MS: z.string().transform(Number).default('120000'),
  STT_IMPROVED_FALLBACK: z.string().transform((v) => !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())).default('true'),

  // Modal CLI credentials — used by backend to deploy/destroy voice-convert apps on behalf of users.
  MODAL_TOKEN_ID: z.string().optional(),
  MODAL_TOKEN_SECRET: z.string().optional(),
  MODAL_WORKSPACE: z.string().optional(),

  // API-key front door for voice cloning (mirrors the Supabase web flow above, same intake/consent/quota
  // rules, different auth). Only the gateway (realtime-tts-gateway) calls this path, after it has already
  // validated the caller's API key and resolved an owning identity; it proves that to us with this shared
  // secret rather than us re-validating keys we don't store. Dark by default, same posture as the web flow:
  // VOICE_STUDIO_API_ENABLED_KEYS empty = every request 404s regardless of key validity.
  GATEWAY_FORWARD_SECRET: z.string().optional(),
  VOICE_STUDIO_API_ENABLED_KEYS: z.string().default(''),
  VOICE_STUDIO_API_MAX_VOICES_PER_KEY: z.string().transform(Number).default('3'),
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
