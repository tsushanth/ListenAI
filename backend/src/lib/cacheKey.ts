import crypto from 'crypto';

// ============================================================================
// TTS Cache Key Generation
// ============================================================================

/**
 * Options for cache key generation
 */
export interface CacheKeyOptions {
  text: string;
  voiceId: string;
  modelId?: string;
  speed?: number;
  format?: 'mp3' | 'wav' | 'ogg';
}

/**
 * Normalize text for consistent cache key generation.
 *
 * Transformations:
 * - Trim leading/trailing whitespace
 * - Collapse multiple spaces/newlines into single space
 * - Normalize quotes (curly → straight)
 * - Normalize dashes (em/en dash → hyphen)
 * - Normalize ellipsis (… → ...)
 * - Lowercase (TTS output is case-insensitive for most engines)
 *
 * @param text - Raw input text
 * @returns Normalized text suitable for hashing
 */
export function normalizeText(text: string): string {
  return text
    // Trim whitespace
    .trim()
    // Collapse multiple whitespace (spaces, tabs, newlines) into single space
    .replace(/\s+/g, ' ')
    // Normalize curly quotes to straight quotes
    .replace(/[\u2018\u2019]/g, "'")  // Single curly quotes → '
    .replace(/[\u201C\u201D]/g, '"')  // Double curly quotes → "
    // Normalize dashes
    .replace(/[\u2013\u2014]/g, '-')  // En/Em dash → hyphen
    // Normalize ellipsis
    .replace(/\u2026/g, '...')        // … → ...
    // Normalize other common unicode
    .replace(/\u00A0/g, ' ')          // Non-breaking space → space
    .replace(/\u200B/g, '')           // Zero-width space → remove
    // Lowercase for case-insensitive matching
    .toLowerCase();
}

/**
 * Compute SHA-256 hash of a string.
 *
 * @param input - String to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Compute a cache key for TTS synthesis.
 *
 * The cache key uniquely identifies a synthesis request based on:
 * - Model ID (e.g., 'kokoro-82m')
 * - Voice ID (e.g., 'am_adam')
 * - Speed (normalized to 2 decimal places)
 * - Format (e.g., 'mp3')
 * - Normalized text content
 *
 * Two requests with the same cache key will produce identical audio output.
 *
 * @param options - Cache key options
 * @returns SHA-256 hash as cache key
 *
 * @example
 * ```typescript
 * const cacheKey = computeCacheKey({
 *   text: 'Hello, world!',
 *   voiceId: 'am_adam',
 *   modelId: 'kokoro-82m',
 *   speed: 1.0,
 *   format: 'mp3'
 * });
 * // Returns: '3a7bd3e2c4f8a1b9...' (64-char hex string)
 * ```
 */
export function computeCacheKey(options: CacheKeyOptions): string {
  const {
    text,
    voiceId,
    modelId = 'kokoro-82m',
    speed = 1.0,
    format = 'mp3'
  } = options;

  // Normalize text
  const normalizedText = normalizeText(text);

  // Normalize speed to 2 decimal places
  const normalizedSpeed = speed.toFixed(2);

  // Build composite key string
  // Format: model|voice|speed|format|text_hash
  const textHash = sha256(normalizedText);
  const compositeKey = `${modelId}|${voiceId}|${normalizedSpeed}|${format}|${textHash}`;

  // Return final hash
  return sha256(compositeKey);
}

/**
 * Compute just the text hash portion (for privacy-preserving storage).
 *
 * @param text - Raw input text
 * @returns SHA-256 hash of normalized text
 */
export function computeTextHash(text: string): string {
  return sha256(normalizeText(text));
}

/**
 * Validate that a cache key matches the expected format.
 *
 * @param key - Cache key to validate
 * @returns True if valid SHA-256 hex string
 */
export function isValidCacheKey(key: string): boolean {
  return /^[a-f0-9]{64}$/.test(key);
}

/**
 * Parse components from a cache key (for debugging).
 * Note: This only works if you have the original inputs.
 *
 * @param cacheKey - The cache key
 * @param options - Original options used to generate the key
 * @returns True if the key matches the options
 */
export function verifyCacheKey(cacheKey: string, options: CacheKeyOptions): boolean {
  const computed = computeCacheKey(options);
  return cacheKey === computed;
}

// ============================================================================
// Cache Path Generation
// ============================================================================

/**
 * Generate a storage path for cached audio.
 *
 * @param cacheKey - The cache key
 * @param format - Audio format
 * @returns Storage path suitable for Supabase Storage
 *
 * @example
 * ```typescript
 * const path = generateAudioPath('abc123...', 'mp3');
 * // Returns: 'audio/cache/ab/c1/abc123....mp3'
 * ```
 */
export function generateAudioPath(cacheKey: string, format: string): string {
  // Use first 4 chars as directory sharding (2 levels)
  // This prevents too many files in a single directory
  const shard1 = cacheKey.substring(0, 2);
  const shard2 = cacheKey.substring(2, 4);

  return `audio/cache/${shard1}/${shard2}/${cacheKey}.${format}`;
}

/**
 * Generate a storage path for job-specific audio (not cached globally).
 *
 * @param jobId - The job UUID
 * @param format - Audio format
 * @returns Storage path
 */
export function generateJobAudioPath(jobId: string, format: string): string {
  return `audio/jobs/${jobId}.${format}`;
}

// ============================================================================
// Sound Effect Cache Key Generation
// ============================================================================
//
// Mirrors the equivalent "Music Cache Key Generation" section in the (as yet
// unmerged) text-to-music feature branch's cacheKey.ts — same shape
// (prompt + duration -> SHA-256 hash), added here directly since that
// branch's music helpers aren't in this repo yet. If/when text-to-music
// merges, keep both sections side by side rather than deduplicating them
// into one generic helper — the two features are versioned independently
// (see the "sfx-v1" vs "music-v1" namespace prefixes below) and a shared
// helper would couple their cache-key formats together unnecessarily.

/**
 * Options for sound effect cache key generation
 */
export interface SoundEffectCacheKeyOptions {
  prompt: string;
  durationSec: number;
}

/**
 * Compute a cache key for sound effect generation.
 *
 * The cache key uniquely identifies a sound effect generation request based on:
 * - Prompt (normalized text describing the desired sound effect)
 * - Duration in seconds
 *
 * Two requests with the same cache key will produce identical audio output.
 * Uses a distinct "sfx-v1" namespace so a sound-effect request never
 * collides with a text-to-music request with an otherwise-identical
 * prompt/duration.
 *
 * @param options - Cache key options
 * @returns SHA-256 hash as cache key
 */
export function computeSoundEffectCacheKey(options: SoundEffectCacheKeyOptions): string {
  const normalizedPrompt = normalizeText(options.prompt);
  const promptHash = sha256(normalizedPrompt);
  const compositeKey = `sfx-v1|${options.durationSec}|${promptHash}`;
  return sha256(compositeKey);
}

/**
 * Generate a storage path for sound effect audio file.
 *
 * @param jobId - The job ID
 * @returns Storage path suitable for storage
 *
 * @example
 * ```typescript
 * const path = generateSoundEffectAudioPath('job-abc-123');
 * // Returns: 'sound-effects/jobs/job-abc-123.wav'
 * ```
 */
export function generateSoundEffectAudioPath(jobId: string): string {
  return `sound-effects/jobs/${jobId}.wav`;
}
