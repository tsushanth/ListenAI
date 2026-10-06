// In-memory doubles shared by the voice-cloning tests. Not imported by production code.
import { randomUUID } from 'node:crypto';
import type {
  AbuseReport, AsrClient, AudioMetrics, BlobStore, CloneServiceClient, CloneStore, ConsentChallengeRow, ConsentRecord,
  OutputHashRecord, SynthesisResult, VoiceCloneRow,
} from './types.js';

export class MemoryStore implements CloneStore {
  challenges = new Map<string, ConsentChallengeRow>();
  consents = new Map<string, ConsentRecord & { retainUntil?: string }>();
  voices = new Map<string, VoiceCloneRow>();
  outputs: OutputHashRecord[] = [];
  reports: AbuseReport[] = [];
  creationLog: Array<{ userId: string; at: string }> = [];
  purgedOutputsFor: string[] = [];

  async createChallenge(c: { userId: string; phrase: string; codeWords: string[]; expiresAt: string }) {
    const row: ConsentChallengeRow = { id: randomUUID(), userId: c.userId, phrase: c.phrase, codeWords: c.codeWords, expiresAt: c.expiresAt, attempts: 0, consumedAt: null };
    this.challenges.set(row.id, row);
    return row;
  }
  async getChallenge(id: string, userId: string) {
    const c = this.challenges.get(id);
    return c && c.userId === userId ? { ...c } : null;
  }
  async incrementChallengeAttempts(id: string) { const c = this.challenges.get(id)!; c.attempts += 1; return c.attempts; }
  async consumeChallenge(id: string, at: string) { this.challenges.get(id)!.consumedAt = at; }
  async countVoiceCreationsSince(userId: string, since: string) {
    return this.creationLog.filter((x) => x.userId === userId && x.at >= since).length;
  }
  async insertConsent(c: ConsentRecord) { this.consents.set(c.id, c); }
  async insertVoice(v: VoiceCloneRow) { this.voices.set(v.id, v); this.creationLog.push({ userId: v.userId, at: v.createdAt }); }
  async getVoice(id: string, userId?: string) {
    const v = this.voices.get(id);
    return v && (userId === undefined || v.userId === userId) ? { ...v } : null;
  }
  async listVoices(userId: string) { return [...this.voices.values()].filter((v) => v.userId === userId && v.status !== 'deleted'); }
  async setVoiceStatus(id: string, patch: { status: VoiceCloneRow['status']; disabledReason?: string | null; disabledAt?: string | null; deletedAt?: string | null }) {
    const v = this.voices.get(id)!;
    v.status = patch.status;
    if (patch.disabledReason !== undefined) v.disabledReason = patch.disabledReason;
    if (patch.disabledAt !== undefined) v.disabledAt = patch.disabledAt;
    if (patch.deletedAt !== undefined) v.deletedAt = patch.deletedAt;
  }
  async setConsentRetention(consentId: string, retainUntil: string) { this.consents.get(consentId)!.retainUntil = retainUntil; }
  async insertOutputHash(o: OutputHashRecord) { this.outputs.push(o); }
  async purgeExpiredOutputHashes(now: string) {
    const before = this.outputs.length;
    this.outputs = this.outputs.filter((o) => o.expiresAt > now);
    return before - this.outputs.length;
  }
  async purgeVoiceOutputs(voiceId: string) { this.purgedOutputsFor.push(voiceId); return 2; }
  async insertAbuseReport(r: AbuseReport) { this.reports.push(r); }
  async listExpiredConsents(now: string) {
    return [...this.consents.values()].filter((c) => c.retainUntil && c.retainUntil <= now).map((c) => ({ id: c.id, clipPath: c.clipPath }));
  }
  async deleteConsent(id: string) {
    this.consents.delete(id);
    for (const [vid, v] of this.voices) if (v.consentId === id) this.voices.delete(vid);
  }
}

export class MemoryBlobs implements BlobStore {
  objects = new Map<string, Buffer>();
  async put(path: string, data: Buffer) { this.objects.set(path, data); }
  async remove(paths: string[]) { for (const p of paths) this.objects.delete(p); }
}

export const GOOD_METRICS: AudioMetrics = { durationSec: 12, speechSec: 10, snrDb: 28, clippingRatio: 0, minWindowSimilarity: 0.7, musicProb: 0.02 };

export class FakeService implements CloneServiceClient {
  calls: string[] = [];
  analyzeResult: (audio: Buffer, filename: string) => AudioMetrics = () => GOOD_METRICS;
  similarityValue = 0.72;
  failCreate = false;
  failDelete = false;
  failDisable = false;
  voices = new Set<string>();
  disabled = new Set<string>();
  async analyze(audio: Buffer, filename: string) { this.calls.push('analyze'); return this.analyzeResult(audio, filename); }
  async similarity() { this.calls.push('similarity'); return this.similarityValue; }
  async createVoice(p: { voiceId: string }) {
    this.calls.push('createVoice');
    if (this.failCreate) throw new Error('boom');
    this.voices.add(p.voiceId);
    return { referenceSec: 12 };
  }
  async synthesize(): Promise<SynthesisResult> {
    this.calls.push('synthesize');
    return { audio: Buffer.from('RIFFfake'), sampleRate: 24000, watermarkScore: 1, watermarkScheme: 'perth', modelId: 'chatterbox-mtl-v3' };
  }
  async deleteVoice(id: string) { this.calls.push('deleteVoice'); if (this.failDelete) throw new Error('down'); this.voices.delete(id); }
  async disableVoice(id: string) { this.calls.push('disableVoice'); if (this.failDisable) throw new Error('down'); this.disabled.add(id); }
}

/** ASR double that "hears" whatever phrase the test says it heard. */
export class FakeAsr implements AsrClient {
  heard: string | null = null;
  /** Overrides `heard` per call, e.g. to read a different phrase for each concurrent request. */
  heardFor?: (audio: Buffer) => string;
  fail = false;
  async transcribe(audio: Buffer) {
    if (this.fail) throw new Error('asr down');
    return this.heardFor ? this.heardFor(audio) : (this.heard ?? '');
  }
}
