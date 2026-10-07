// Orchestration for consent-gated voice cloning. Pure of HTTP/DB specifics (everything injected), so the
// order of the gates is covered by unit tests:
//   eligibility (verified email + payment) -> daily limit -> challenge -> reference gate ->
//   consent (ASR + speaker similarity) -> create voice on the serving app -> persist consent + voice.
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../types/index.js';
import type {
  AsrClient, BlobStore, CloneServiceClient, CloneStore, Eligibility, OutputHashRecord, SynthesisResult, VoiceCloneRow,
} from './types.js';
import type { ClonePolicy } from './policy.js';
import { issuePhrase } from './consentPhrase.js';
import { evaluateConsentClip, evaluateReference } from './referenceGate.js';
import { evaluateConsent } from './consent.js';

export const CLONE_MODEL_ID = 'chatterbox-mtl-v3';
export const SIMILARITY_MODEL = 'speechbrain/spkrec-ecapa-voxceleb';
/** Chatterbox Multilingual languages. */
export const SUPPORTED_LANGUAGES = new Set([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
]);

export class CloneError extends AppError {
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(status, code, message, details);
    this.name = 'CloneError';
  }
  get status(): number {
    return this.statusCode;
  }
}

export interface CloneDeps {
  store: CloneStore;
  blobs: BlobStore;
  service: CloneServiceClient;
  asr: AsrClient;
  policy: ClonePolicy;
  now?: () => Date;
  newId?: () => string;
  /** Evaluated per request. Omitted = true (strict). false = attestation mode (VOICE_CLONE_REQUIRE_CONSENT_PHRASE="false"). */
  consentRequired?: () => boolean;
}

export const isConsentRequired = (deps: Pick<CloneDeps, 'consentRequired'>): boolean => (deps.consentRequired ? deps.consentRequired() : true);

/** Marker stored in the evidence rows written in attestation mode (no recording exists). */
export const ATTESTED = 'ATTESTED';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + m); return x; };

// Per-process guard against two concurrent creations racing past the daily-limit count. A multi-instance
// deployment would need a DB-level constraint; see docs/VOICE_CLONING_CONSENT.md (known limitation).
const inFlight = new Set<string>();

export function assertEligible(e: Eligibility): void {
  if (!e.emailVerified) throw new CloneError(403, 'email_unverified', 'Verify your email address before creating a cloned voice.');
  if (!e.plan) throw new CloneError(402, 'payment_required', 'Voice cloning requires an active paid plan with a payment method on file.');
}

export function dailyLimitFor(e: Eligibility, p: ClonePolicy): number {
  return e.plan === 'comped' ? p.dailyLimitTrial : p.dailyLimitPaid;
}

export async function issueConsentChallenge(deps: CloneDeps, e: Eligibility) {
  assertEligible(e);
  if (!isConsentRequired(deps)) throw new CloneError(409, 'consent_not_required', 'Consent phrase is not required; send attested=true instead.');
  const now = (deps.now ?? (() => new Date()))();
  const { phrase, codeWords } = issuePhrase();
  const expiresAt = new Date(now.getTime() + deps.policy.challengeTtlSec * 1000).toISOString();
  const row = await deps.store.createChallenge({ userId: e.userId, phrase, codeWords, expiresAt });
  return { challengeId: row.id, phrase: row.phrase, expiresAt: row.expiresAt };
}

export interface CreateVoiceInput {
  eligibility: Eligibility;
  name: string;
  language: string;
  /** Strict mode only. */
  challengeId?: string;
  /** Strict mode only. */
  consent?: { audio: Buffer; mime: string };
  /** Attestation mode only: the user ticked the attestation. Ignored (never a bypass) in strict mode. */
  attested?: boolean;
  reference: { audio: Buffer; mime: string; filename: string };
}

export async function createVoiceClone(deps: CloneDeps, input: CreateVoiceInput) {
  const { store, blobs, service, asr, policy } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? randomUUID;
  const e = input.eligibility;

  assertEligible(e);
  const strict = isConsentRequired(deps);
  if (!strict && input.attested !== true) {
    throw new CloneError(422, 'attestation_required', 'You must confirm that this is your own voice or that you have the speaker\'s permission.');
  }
  if (strict && (!input.challengeId || !input.consent)) {
    throw new CloneError(400, 'audio_required', 'A consent challenge and a consent recording are required.');
  }
  if (!SUPPORTED_LANGUAGES.has(input.language)) {
    throw new CloneError(400, 'unsupported_language', `Unsupported language: ${input.language}`);
  }
  if (inFlight.has(e.userId)) {
    throw new CloneError(429, 'creation_in_progress', 'A voice creation is already in progress for this account.');
  }
  inFlight.add(e.userId);
  try {
    // 1. Daily limit (counts deleted voices too).
    const limit = dailyLimitFor(e, policy);
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const used = await store.countVoiceCreationsSince(e.userId, since);
    if (used >= limit) {
      throw new CloneError(429, 'daily_limit', `You can create ${limit} cloned voices per 24 hours.`, { limit, used });
    }

    if (!strict) return await createAttested(deps, input, now, newId);

    // 2. Challenge must be ours, unexpired, unused, and not out of attempts.
    const ch = await store.getChallenge(input.challengeId!, e.userId);
    if (!ch) throw new CloneError(404, 'challenge_not_found', 'Consent challenge not found. Request a new one.');
    if (ch.consumedAt) throw new CloneError(409, 'challenge_used', 'This consent challenge was already used. Request a new one.');
    if (new Date(ch.expiresAt).getTime() <= now.getTime()) throw new CloneError(410, 'challenge_expired', 'The consent challenge expired. Request a new one.');
    if (ch.attempts >= policy.maxConsentAttempts) throw new CloneError(429, 'challenge_attempts_exhausted', 'Too many failed attempts. Request a new challenge.');

    // 3. Reference gate (measured on the serving app).
    const refMetrics = await service.analyze(input.reference.audio, input.reference.filename);
    const refGate = evaluateReference(refMetrics, policy);
    if (!refGate.ok) throw new CloneError(422, 'reference_rejected', 'The reference audio cannot be used.', { failures: refGate.failures });
    const consentMetrics = await service.analyze(input.consent!.audio, 'consent');
    const consentGate = evaluateConsentClip(consentMetrics, policy);
    if (!consentGate.ok) throw new CloneError(422, 'consent_clip_rejected', 'The consent recording cannot be used.', { failures: consentGate.failures });

    // 4. Consent: counts as an attempt whether or not it passes.
    const attempts = await store.incrementChallengeAttempts(ch.id);
    const ev = await evaluateConsent(
      { phrase: ch.phrase, codeWords: ch.codeWords, consentAudio: input.consent!.audio, consentMime: input.consent!.mime, referenceAudio: input.reference.audio },
      { asr, service, policy }
    );
    if (!ev.ok) {
      if (attempts >= policy.maxConsentAttempts) await store.consumeChallenge(ch.id, now.toISOString());
      const status = ev.failure === 'asr_unavailable' ? 503 : 422;
      throw new CloneError(status, ev.failure!, ev.failure === 'phrase_mismatch'
        ? 'We could not match what you said to the phrase. Read it exactly as shown.'
        : ev.failure === 'speaker_mismatch'
          ? 'The voice in the consent recording does not match the reference audio. You can only clone your own voice.'
          : 'Consent verification is temporarily unavailable. Try again later.',
      { attemptsLeft: Math.max(0, policy.maxConsentAttempts - attempts) });
    }

    // 5. Create on the serving app, then persist; compensate if persistence fails.
    const voiceId = newId();
    const consentId = newId();
    const clipPath = `${e.userId}/${consentId}.wav`;
    const created = await service.createVoice({ voiceId, audio: input.reference.audio, filename: input.reference.filename, language: input.language });
    try {
      await blobs.put(clipPath, input.consent!.audio, input.consent!.mime || 'audio/wav');
      const createdAt = now.toISOString();
      await store.insertConsent({
        id: consentId, userId: e.userId, challengeId: ch.id, phrase: ch.phrase, transcript: ev.transcript,
        phraseWer: ev.phraseWer, speakerSimilarity: ev.speakerSimilarity!, similarityThreshold: policy.similarityThreshold,
        similarityModel: SIMILARITY_MODEL, borderline: ev.borderline, clipPath, clipSha256: sha256(input.consent!.audio),
        clipSec: consentMetrics.durationSec, createdAt,
      });
      const voice: VoiceCloneRow = {
        id: voiceId, userId: e.userId, name: input.name, language: input.language, status: 'active', consentId,
        referenceSha256: sha256(input.reference.audio), referenceSec: created.referenceSec, modelId: CLONE_MODEL_ID,
        disabledReason: null, disabledAt: null, deletedAt: null, createdAt,
      };
      await store.insertVoice(voice);
      await store.consumeChallenge(ch.id, createdAt);
      return { voice, similarity: ev.speakerSimilarity!, borderline: ev.borderline };
    } catch (err) {
      await service.deleteVoice(voiceId).catch(() => undefined);
      throw err;
    }
  } finally {
    inFlight.delete(e.userId);
  }
}

/**
 * Attestation mode: no consent recording, no ASR, no similarity call, nothing uploaded to the consent bucket.
 * voice_clones.consent_id is NOT NULL, so an audit trail is still written (challenge consumed at once + consent row,
 * both marked ATTESTED; NOT NULL text columns hold ''; code_words is the empty array). No schema change needed.
 */
async function createAttested(deps: CloneDeps, input: CreateVoiceInput, now: Date, newId: () => string) {
  const { store, service, policy } = deps;
  const e = input.eligibility;
  // Daily limit was already enforced by the caller (createVoiceClone), before this point.
  const refMetrics = await service.analyze(input.reference.audio, input.reference.filename);
  const refGate = evaluateReference(refMetrics, policy);
  if (!refGate.ok) throw new CloneError(422, 'reference_rejected', 'The reference audio cannot be used.', { failures: refGate.failures });

  const voiceId = newId();
  const consentId = newId();
  const created = await service.createVoice({ voiceId, audio: input.reference.audio, filename: input.reference.filename, language: input.language });
  try {
    const createdAt = now.toISOString();
    const ch = await store.createChallenge({ userId: e.userId, phrase: ATTESTED, codeWords: [], expiresAt: createdAt });
    await store.consumeChallenge(ch.id, createdAt);
    await store.insertConsent({
      id: consentId, userId: e.userId, challengeId: ch.id, phrase: ATTESTED, transcript: ATTESTED, phraseWer: 0,
      speakerSimilarity: 0, similarityThreshold: 0, similarityModel: 'none', borderline: false, clipPath: '', clipSha256: '',
      clipSec: null, createdAt,
    });
    const voice: VoiceCloneRow = {
      id: voiceId, userId: e.userId, name: input.name, language: input.language, status: 'active', consentId,
      referenceSha256: sha256(input.reference.audio), referenceSec: created.referenceSec, modelId: CLONE_MODEL_ID,
      disabledReason: null, disabledAt: null, deletedAt: null, createdAt,
    };
    await store.insertVoice(voice);
    return { voice, similarity: 0, borderline: false };
  } catch (err) {
    await service.deleteVoice(voiceId).catch(() => undefined);
    throw err;
  }
}

/** Resolve a voice for synthesis; throws unless it is active, owned by the caller and the account is still eligible. */
export async function getUsableVoice(store: CloneStore, voiceId: string, e: Eligibility): Promise<VoiceCloneRow> {
  assertEligible(e);
  const v = await store.getVoice(voiceId, e.userId);
  if (!v || v.status === 'deleted') throw new CloneError(404, 'voice_not_found', 'Cloned voice not found.');
  if (v.status === 'disabled') throw new CloneError(403, 'voice_disabled', 'This voice has been disabled.');
  if (v.status !== 'active') throw new CloneError(409, 'voice_unavailable', 'This voice is being deleted.');
  return v;
}

/** User-initiated deletion: reference audio, embeddings and cached conditionals go; consent evidence stays for the retention period. */
export async function deleteVoiceClone(deps: CloneDeps, userId: string, voiceId: string) {
  const { store, service, policy } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const v = await store.getVoice(voiceId, userId);
  if (!v) throw new CloneError(404, 'voice_not_found', 'Cloned voice not found.');
  if (v.status === 'deleted') return { deleted: true, alreadyDeleted: true };
  await store.setVoiceStatus(voiceId, { status: 'deleting' });
  try {
    await service.deleteVoice(voiceId);
  } catch {
    throw new CloneError(502, 'deletion_pending', 'The voice is disabled and queued for deletion but the audio store did not confirm. Retry this request.');
  }
  await store.setVoiceStatus(voiceId, { status: 'deleted', deletedAt: now.toISOString() });
  await store.setConsentRetention(v.consentId, addMonths(now, policy.consentRetentionMonthsAfterDelete).toISOString());
  return { deleted: true, alreadyDeleted: false };
}

/** Abuse takedown: voice unusable everywhere immediately, generated outputs purged, evidence (reference, consent, hashes) preserved. */
export async function disableVoiceClone(deps: CloneDeps, voiceId: string, reason: string) {
  const { store, service } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const v = await store.getVoice(voiceId);
  if (!v) throw new CloneError(404, 'voice_not_found', 'Cloned voice not found.');
  await store.setVoiceStatus(voiceId, { status: 'disabled', disabledReason: reason, disabledAt: now.toISOString() });
  let serviceDisabled = true;
  try { await service.disableVoice(voiceId); } catch { serviceDisabled = false; }
  const purged = await store.purgeVoiceOutputs(voiceId);
  return { voiceId, status: 'disabled' as const, outputsPurged: purged, serviceDisabled };
}

/** Called after each synthesis: retain the output hash (and watermark metadata) for the retention window. */
export async function recordOutput(deps: Pick<CloneDeps, 'store' | 'policy' | 'now'>, p: { voiceId: string; userId: string; audio: Buffer; chars: number; synth: Pick<SynthesisResult, 'watermarkScheme' | 'watermarkScore'> }) {
  const now = (deps.now ?? (() => new Date()))();
  const rec: OutputHashRecord = {
    voiceId: p.voiceId, userId: p.userId, sha256: sha256(p.audio), bytes: p.audio.length, chars: p.chars,
    watermarkScheme: p.synth.watermarkScheme, watermarkScore: p.synth.watermarkScore,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + deps.policy.outputHashRetentionDays * 86400_000).toISOString(),
  };
  await deps.store.insertOutputHash(rec);
  return rec;
}

/**
 * Retention sweep: output hashes past 90 days, and consent evidence (row + clip) past deletion + 12 months.
 * Intended for a daily scheduler; NOT scheduled by this change (needs an owner decision on where it runs).
 */
export async function purgeExpired(deps: Pick<CloneDeps, 'store' | 'now'> & { blobs?: BlobStore }) {
  const now = ((deps.now ?? (() => new Date()))()).toISOString();
  const outputHashes = await deps.store.purgeExpiredOutputHashes(now);
  let consents = 0;
  if (deps.blobs) {
    for (const c of await deps.store.listExpiredConsents(now)) {
      if (c.clipPath) await deps.blobs.remove([c.clipPath]); // '' = attestation-mode evidence, no clip exists
      await deps.store.deleteConsent(c.id);
      consents += 1;
    }
  }
  return { outputHashes, consents };
}
