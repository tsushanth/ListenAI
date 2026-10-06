-- Rollback for 033_voice_clone_consent.sql. DESTRUCTIVE: drops consent evidence and output hashes.
-- Export them first if you need to keep them. The dropped tts_jobs foreign key is NOT restored (existing
-- rows may now hold voice_clones ids that would violate it); re-add it manually only after cleaning those rows.
BEGIN;
DROP POLICY IF EXISTS "deny anon access to voice-consent bucket" ON storage.objects;
DROP TABLE IF EXISTS voice_clone_abuse_reports;
DROP TABLE IF EXISTS voice_clone_output_hashes;
DROP TABLE IF EXISTS voice_clones;
DROP TABLE IF EXISTS voice_consents;
DROP FUNCTION IF EXISTS increment_voice_challenge_attempts(UUID);
DROP TABLE IF EXISTS voice_consent_challenges;
-- The 'voice-consent' bucket is left in place: delete its objects through the Storage API first.
COMMIT;
