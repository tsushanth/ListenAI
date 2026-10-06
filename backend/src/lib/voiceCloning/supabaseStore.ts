// Supabase-backed CloneStore / BlobStore. Tables are created by backend/supabase/migrations/033_voice_clone_consent.sql
// (NOT applied by this change). All access goes through the service-role client; the tables are RLS-locked.
import { supabase, AUDIO_BUCKET } from '../supabaseClient.js';
import type {
  AbuseReport, BlobStore, CloneStore, ConsentChallengeRow, ConsentRecord, OutputHashRecord, VoiceCloneRow, VoiceStatus,
} from './types.js';

const CONSENT_BUCKET = 'voice-consent';

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

interface ChallengeDb { id: string; user_id: string; phrase: string; code_words: string[]; expires_at: string; attempts: number; consumed_at: string | null }
const toChallenge = (r: ChallengeDb): ConsentChallengeRow => ({
  id: r.id, userId: r.user_id, phrase: r.phrase, codeWords: r.code_words, expiresAt: r.expires_at, attempts: r.attempts, consumedAt: r.consumed_at,
});

interface VoiceDb {
  id: string; user_id: string; name: string; language: string; status: VoiceStatus; consent_id: string; reference_sha256: string;
  reference_sec: number | string; model_id: string; disabled_reason: string | null; disabled_at: string | null; deleted_at: string | null; created_at: string;
}
const toVoice = (r: VoiceDb): VoiceCloneRow => ({
  id: r.id, userId: r.user_id, name: r.name, language: r.language, status: r.status, consentId: r.consent_id,
  referenceSha256: r.reference_sha256, referenceSec: Number(r.reference_sec), modelId: r.model_id,
  disabledReason: r.disabled_reason, disabledAt: r.disabled_at, deletedAt: r.deleted_at, createdAt: r.created_at,
});

export const supabaseCloneStore: CloneStore = {
  async createChallenge(c) {
    const data = must(await supabase.from('voice_consent_challenges')
      .insert({ user_id: c.userId, phrase: c.phrase, code_words: c.codeWords, expires_at: c.expiresAt }).select().single(), 'createChallenge');
    return toChallenge(data as unknown as ChallengeDb);
  },
  async getChallenge(id, userId) {
    const data = must(await supabase.from('voice_consent_challenges').select('*').eq('id', id).eq('user_id', userId).maybeSingle(), 'getChallenge');
    return data ? toChallenge(data as ChallengeDb) : null;
  },
  async incrementChallengeAttempts(id) {
    const data = must(await supabase.rpc('increment_voice_challenge_attempts', { p_id: id }), 'incrementChallengeAttempts');
    return Number(data);
  },
  async consumeChallenge(id, at) {
    must(await supabase.from('voice_consent_challenges').update({ consumed_at: at }).eq('id', id), 'consumeChallenge');
  },
  async countVoiceCreationsSince(userId, since) {
    const res = await supabase.from('voice_clones').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since);
    if (res.error) throw new Error(`countVoiceCreationsSince: ${res.error.message}`);
    return res.count ?? 0;
  },
  async insertConsent(c: ConsentRecord) {
    must(await supabase.from('voice_consents').insert({
      id: c.id, user_id: c.userId, challenge_id: c.challengeId, phrase: c.phrase, transcript: c.transcript, phrase_wer: c.phraseWer,
      speaker_similarity: c.speakerSimilarity, similarity_threshold: c.similarityThreshold, similarity_model: c.similarityModel,
      borderline: c.borderline, clip_path: c.clipPath, clip_sha256: c.clipSha256, clip_sec: c.clipSec, created_at: c.createdAt,
    }), 'insertConsent');
  },
  async insertVoice(v) {
    must(await supabase.from('voice_clones').insert({
      id: v.id, user_id: v.userId, name: v.name, language: v.language, status: v.status, consent_id: v.consentId,
      reference_sha256: v.referenceSha256, reference_sec: v.referenceSec, model_id: v.modelId, created_at: v.createdAt,
    }), 'insertVoice');
  },
  async getVoice(id, userId) {
    let q = supabase.from('voice_clones').select('*').eq('id', id);
    if (userId !== undefined) q = q.eq('user_id', userId);
    const data = must(await q.maybeSingle(), 'getVoice');
    return data ? toVoice(data as VoiceDb) : null;
  },
  async listVoices(userId) {
    const data = must(await supabase.from('voice_clones').select('*').eq('user_id', userId).neq('status', 'deleted').order('created_at', { ascending: false }), 'listVoices');
    return ((data ?? []) as VoiceDb[]).map(toVoice);
  },
  async setVoiceStatus(id, patch) {
    const upd: Record<string, unknown> = { status: patch.status };
    if (patch.disabledReason !== undefined) upd.disabled_reason = patch.disabledReason;
    if (patch.disabledAt !== undefined) upd.disabled_at = patch.disabledAt;
    if (patch.deletedAt !== undefined) upd.deleted_at = patch.deletedAt;
    must(await supabase.from('voice_clones').update(upd).eq('id', id), 'setVoiceStatus');
  },
  async setConsentRetention(consentId, retainUntil) {
    must(await supabase.from('voice_consents').update({ retain_until: retainUntil }).eq('id', consentId), 'setConsentRetention');
  },
  async insertOutputHash(o: OutputHashRecord) {
    must(await supabase.from('voice_clone_output_hashes').insert({
      voice_id: o.voiceId, user_id: o.userId, sha256: o.sha256, bytes: o.bytes, chars: o.chars, watermark_scheme: o.watermarkScheme,
      watermark_score: o.watermarkScore, created_at: o.createdAt, expires_at: o.expiresAt,
    }), 'insertOutputHash');
  },
  async purgeExpiredOutputHashes(now) {
    const data = must(await supabase.from('voice_clone_output_hashes').delete().lt('expires_at', now).select('id'), 'purgeExpiredOutputHashes');
    return (data as unknown[] | null)?.length ?? 0;
  },
  async purgeVoiceOutputs(voiceId) {
    const jobs = must(await supabase.from('tts_jobs').select('audio_path, preview_audio_path, full_audio_path').eq('cloned_voice_id', voiceId), 'purgeVoiceOutputs/jobs') as
      Array<{ audio_path: string | null; preview_audio_path: string | null; full_audio_path: string | null }> | null;
    const cache = must(await supabase.from('tts_cache').select('audio_path').eq('voice_id', `cloned-${voiceId}`), 'purgeVoiceOutputs/cache') as Array<{ audio_path: string | null }> | null;
    const paths = new Set<string>();
    for (const j of jobs ?? []) for (const p of [j.audio_path, j.preview_audio_path, j.full_audio_path]) if (p) paths.add(p);
    for (const c of cache ?? []) if (c.audio_path) paths.add(c.audio_path);
    if (paths.size > 0) {
      const { error } = await supabase.storage.from(AUDIO_BUCKET).remove([...paths]);
      if (error) throw new Error(`purgeVoiceOutputs/storage: ${error.message}`);
    }
    must(await supabase.from('tts_cache').delete().eq('voice_id', `cloned-${voiceId}`), 'purgeVoiceOutputs/cache-delete');
    must(await supabase.from('tts_jobs').update({ audio_path: null, preview_audio_path: null, full_audio_path: null, audio_url: null }).eq('cloned_voice_id', voiceId), 'purgeVoiceOutputs/jobs-clear');
    return paths.size;
  },
  async insertAbuseReport(r: AbuseReport) {
    must(await supabase.from('voice_clone_abuse_reports').insert({
      id: r.id, voice_id: r.voiceId, reporter_contact: r.reporterContact, category: r.category, details: r.details, created_at: r.createdAt,
    }), 'insertAbuseReport');
  },
  async listExpiredConsents(now) {
    const data = must(await supabase.from('voice_consents').select('id, clip_path').lt('retain_until', now), 'listExpiredConsents') as Array<{ id: string; clip_path: string }> | null;
    return (data ?? []).map((r) => ({ id: r.id, clipPath: r.clip_path }));
  },
  async deleteConsent(id) {
    must(await supabase.from('voice_consents').delete().eq('id', id), 'deleteConsent');
  },
};

export const supabaseConsentBlobs: BlobStore = {
  async put(path, data, contentType) {
    const { error } = await supabase.storage.from(CONSENT_BUCKET).upload(path, data, { contentType, upsert: false });
    if (error) throw new Error(`consent clip upload: ${error.message}`);
  },
  async remove(paths) {
    const { error } = await supabase.storage.from(CONSENT_BUCKET).remove(paths);
    if (error) throw new Error(`consent clip remove: ${error.message}`);
  },
};
