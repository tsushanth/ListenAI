// Shared interfaces for the consent-gated voice-cloning flow. Everything that touches the network or
// the database is behind one of these so the gate logic is unit-testable with doubles.

/** Metrics the serving app (modal/chatterbox_clone.py /analyze) measures on an uploaded clip. */
export interface AudioMetrics {
  durationSec: number;
  /** Seconds of detected speech (frame-energy VAD). */
  speechSec: number;
  /** Heuristic SNR: loud-frame power vs noise-floor power, dB. */
  snrDb: number;
  /** Fraction of samples at digital full scale. */
  clippingRatio: number;
  /** Min cosine of any speech window embedding to the clip centroid; null if clip too short for >=2 windows. */
  minWindowSimilarity: number | null;
  /** AudioSet 'Music' class probability (max over windows), 0..1. */
  musicProb: number;
}

export interface CloneServiceClient {
  analyze(audio: Buffer, filename: string): Promise<AudioMetrics>;
  /** Speaker-embedding cosine similarity between two clips (same embedding the threshold was calibrated on). */
  similarity(a: Buffer, b: Buffer): Promise<number>;
  createVoice(params: { voiceId: string; audio: Buffer; filename: string; language: string }): Promise<{ referenceSec: number }>;
  synthesize(params: { voiceId: string; text: string; language: string; speed?: number }): Promise<SynthesisResult>;
  /** Removes reference audio, embeddings and cached conditionals for the voice. Idempotent. */
  deleteVoice(voiceId: string): Promise<void>;
  /** Marks the voice unusable on the serving side without deleting (takedown, evidence preserved). */
  disableVoice(voiceId: string): Promise<void>;
}

export interface SynthesisResult {
  audio: Buffer; // WAV
  sampleRate: number;
  /** Perth watermark detection score measured on the generated audio by the serving app (0..1), if reported. */
  watermarkScore: number | null;
  watermarkScheme: string; // 'perth'
  modelId: string;
}

export interface AsrClient {
  transcribe(audio: Buffer, mimeType: string, language?: string): Promise<string>;
}

export type VoiceStatus = 'active' | 'disabled' | 'deleting' | 'deleted';

export interface VoiceCloneRow {
  id: string;
  userId: string;
  name: string;
  language: string;
  status: VoiceStatus;
  consentId: string;
  referenceSha256: string;
  referenceSec: number;
  modelId: string;
  disabledReason: string | null;
  disabledAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ConsentChallengeRow {
  id: string;
  userId: string;
  phrase: string;
  codeWords: string[];
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
}

export interface ConsentRecord {
  id: string;
  userId: string;
  challengeId: string;
  phrase: string;
  transcript: string;
  phraseWer: number;
  speakerSimilarity: number;
  similarityThreshold: number;
  similarityModel: string;
  borderline: boolean;
  clipPath: string;
  clipSha256: string;
  clipSec: number | null;
  createdAt: string;
}

export interface OutputHashRecord {
  voiceId: string;
  userId: string;
  sha256: string;
  bytes: number;
  chars: number;
  watermarkScheme: string;
  watermarkScore: number | null;
  createdAt: string;
  expiresAt: string;
}

export interface AbuseReport {
  id: string;
  voiceId: string | null;
  reporterContact: string;
  category: string;
  details: string;
  createdAt: string;
}

export interface CloneStore {
  createChallenge(c: { userId: string; phrase: string; codeWords: string[]; expiresAt: string }): Promise<ConsentChallengeRow>;
  getChallenge(id: string, userId: string): Promise<ConsentChallengeRow | null>;
  /** Atomically increments and returns the new attempt count. */
  incrementChallengeAttempts(id: string): Promise<number>;
  consumeChallenge(id: string, at: string): Promise<void>;
  /** Voice creations since `since`, INCLUDING deleted/disabled ones, so delete-and-recreate cannot reset the limit. */
  countVoiceCreationsSince(userId: string, since: string): Promise<number>;
  insertConsent(c: ConsentRecord): Promise<void>;
  insertVoice(v: VoiceCloneRow): Promise<void>;
  getVoice(id: string, userId?: string): Promise<VoiceCloneRow | null>;
  listVoices(userId: string): Promise<VoiceCloneRow[]>;
  setVoiceStatus(id: string, patch: { status: VoiceStatus; disabledReason?: string | null; disabledAt?: string | null; deletedAt?: string | null }): Promise<void>;
  /** Sets consent retention (voice life + N months) once the voice is deleted. */
  setConsentRetention(consentId: string, retainUntil: string): Promise<void>;
  insertOutputHash(o: OutputHashRecord): Promise<void>;
  purgeExpiredOutputHashes(now: string): Promise<number>;
  /** Deletes generated audio (job outputs + cache entries) for a voice; returns number of objects removed. */
  purgeVoiceOutputs(voiceId: string): Promise<number>;
  insertAbuseReport(r: AbuseReport): Promise<void>;
  /** Consent rows whose retain_until has passed (voice already deleted). */
  listExpiredConsents(now: string): Promise<Array<{ id: string; clipPath: string }>>;
  /** Deletes the consent row (cascades to the already-deleted voice row). */
  deleteConsent(id: string): Promise<void>;
}

export interface BlobStore {
  put(path: string, data: Buffer, contentType: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}

export type BillingPlan = 'paid' | 'comped';

export interface Eligibility {
  userId: string;
  emailVerified: boolean;
  /** null = no active billing (payment required). */
  plan: BillingPlan | null;
}
