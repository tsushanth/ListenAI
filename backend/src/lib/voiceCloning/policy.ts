// Tunable policy for the voice-cloning consent and reference gates. Every number here is a default
// that MUST be re-tuned on real consented recordings before launch (see docs/VOICE_CLONING_CONSENT.md).
// Read from env on each call so tests and operators can override without a redeploy of code.

export interface ClonePolicy {
  /** Minimum speaker-embedding cosine between the consent clip and the reference audio. */
  similarityThreshold: number;
  /** Scores in [threshold, threshold + margin) are accepted but flagged for owner sampling. */
  borderlineMargin: number;
  /** Max word error rate of the ASR transcript of the consent clip against the issued phrase. */
  maxPhraseWer: number;
  challengeTtlSec: number;
  maxConsentAttempts: number;

  minReferenceSec: number;
  maxReferenceSec: number;
  minSnrDb: number;
  minSpeechRatio: number;
  maxClippingRatio: number;
  /** Min cosine between any 3 s window and the whole-clip centroid; below = probably >1 speaker. */
  minWindowSimilarity: number;
  /** Music class probability (AudioSet 'Music') above which the reference is rejected. */
  maxMusicProb: number;
  minConsentSec: number;
  maxConsentSec: number;

  dailyLimitPaid: number;
  /** Complimentary / trial accounts (billing row comped=true). Spec: "~3/day, 10 on trial". */
  dailyLimitTrial: number;
  consentRetentionMonthsAfterDelete: number;
  outputHashRetentionDays: number;
}

export const DEFAULT_POLICY: ClonePolicy = {
  // REPORT.md calibration (ECAPA, 8 LibriVox readers): same-speaker real-vs-real avg 0.72, p05 0.43;
  // different-speaker p95 0.38. 0.40 sits in the gap. Consent-clip-vs-reference will be noisier than
  // that (different mic/session), so expect a real false-reject rate; tune on consented data.
  similarityThreshold: 0.4,
  borderlineMargin: 0.1,
  maxPhraseWer: 0.2,
  challengeTtlSec: 300,
  maxConsentAttempts: 3,

  minReferenceSec: 8,
  maxReferenceSec: 120,
  minSnrDb: 15, // REPORT: 10 dB noisy refs dropped Chatterbox similarity 0.68 -> 0.33
  minSpeechRatio: 0.5,
  maxClippingRatio: 0.02,
  minWindowSimilarity: 0.3, // heuristic, unmeasured
  maxMusicProb: 0.5, // heuristic, unmeasured
  minConsentSec: 3,
  maxConsentSec: 40,

  dailyLimitPaid: 3,
  dailyLimitTrial: 10,
  consentRetentionMonthsAfterDelete: 12,
  outputHashRetentionDays: 90,
};

const ENV_KEYS: Record<keyof ClonePolicy, string> = {
  similarityThreshold: 'VOICE_CLONE_SIMILARITY_THRESHOLD',
  borderlineMargin: 'VOICE_CLONE_BORDERLINE_MARGIN',
  maxPhraseWer: 'VOICE_CLONE_MAX_PHRASE_WER',
  challengeTtlSec: 'VOICE_CLONE_CHALLENGE_TTL_SEC',
  maxConsentAttempts: 'VOICE_CLONE_MAX_CONSENT_ATTEMPTS',
  minReferenceSec: 'VOICE_CLONE_MIN_REFERENCE_SEC',
  maxReferenceSec: 'VOICE_CLONE_MAX_REFERENCE_SEC',
  minSnrDb: 'VOICE_CLONE_MIN_SNR_DB',
  minSpeechRatio: 'VOICE_CLONE_MIN_SPEECH_RATIO',
  maxClippingRatio: 'VOICE_CLONE_MAX_CLIPPING_RATIO',
  minWindowSimilarity: 'VOICE_CLONE_MIN_WINDOW_SIMILARITY',
  maxMusicProb: 'VOICE_CLONE_MAX_MUSIC_PROB',
  minConsentSec: 'VOICE_CLONE_MIN_CONSENT_SEC',
  maxConsentSec: 'VOICE_CLONE_MAX_CONSENT_SEC',
  dailyLimitPaid: 'VOICE_CLONE_DAILY_LIMIT',
  dailyLimitTrial: 'VOICE_CLONE_TRIAL_DAILY_LIMIT',
  consentRetentionMonthsAfterDelete: 'VOICE_CLONE_CONSENT_RETENTION_MONTHS',
  outputHashRetentionDays: 'VOICE_CLONE_OUTPUT_HASH_RETENTION_DAYS',
};

/** Env overrides; a missing, non-numeric or negative value falls back to the default (never throws). */
export function loadClonePolicy(env: Record<string, string | undefined> = process.env): ClonePolicy {
  const out = { ...DEFAULT_POLICY };
  for (const key of Object.keys(ENV_KEYS) as Array<keyof ClonePolicy>) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}
