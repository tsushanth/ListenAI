/**
 * Voice Mapping Configuration
 *
 * Centralized mapping for Kokoro voice IDs and metadata.
 */

// ============================================================================
// Voice Mappings
// ============================================================================

export interface VoiceInfo {
  name: string;
  gender: 'male' | 'female';
  description: string;
  kokoroId: string;
}

/**
 * Master voice mapping table.
 * Key is the voice name (lowercase), values are voice metadata.
 */
export const VOICE_MAPPING: Record<string, VoiceInfo> = {
  rachel: {
    name: 'Rachel',
    gender: 'female',
    description: 'Warm & Clear',
    kokoroId: 'af_nicole',
  },
  adam: {
    name: 'Adam',
    gender: 'male',
    description: 'Professional Narrator',
    kokoroId: 'am_adam',
  },
  brian: {
    name: 'Brian',
    gender: 'male',
    description: 'Deep British',
    kokoroId: 'bm_george',
  },
  bella: {
    name: 'Bella',
    gender: 'female',
    description: 'Calm & Soothing',
    kokoroId: 'af_bella',
  },
  josh: {
    name: 'Josh',
    gender: 'male',
    description: 'Storyteller',
    kokoroId: 'am_michael',
  },
  charlotte: {
    name: 'Charlotte',
    gender: 'female',
    description: 'Elegant & Articulate',
    kokoroId: 'bf_emma',
  },
};

// ============================================================================
// Lookup Maps (auto-generated from VOICE_MAPPING)
// ============================================================================

/**
 * Kokoro ID -> Voice Info
 */
export const KOKORO_VOICE_INFO: Record<string, VoiceInfo> = Object.fromEntries(
  Object.values(VOICE_MAPPING).map(v => [v.kokoroId, v])
);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize voice ID to Kokoro format.
 * Returns the voice ID as-is if it's already a valid Kokoro ID.
 */
export function normalizeVoiceId(voiceId: string): string {
  // If it's already a Kokoro voice ID, return as-is
  if (isKokoroVoiceId(voiceId)) {
    return voiceId;
  }
  // Default to Adam (male) for unknown voice IDs
  return 'am_adam';
}

/**
 * Get voice info by voice ID.
 */
export function getVoiceInfo(voiceId: string): VoiceInfo | undefined {
  return KOKORO_VOICE_INFO[voiceId];
}

/**
 * Check if a voice ID is a Kokoro ID.
 * Kokoro IDs start with voice type prefix (af_, am_, bf_, bm_).
 */
export function isKokoroVoiceId(voiceId: string): boolean {
  return /^[ab][fm]_/.test(voiceId);
}

/**
 * Get the default voice ID.
 */
export function getDefaultVoiceId(): string {
  return 'am_adam';  // Adam (male)
}
