-- ============================================================================
-- Migration 030: Lock the remaining open public tables to the service role
--
-- 24 tables carried a policy `FOR ALL TO PUBLIC USING (true)` and anon/authenticated held full
-- table grants, so the public anon key (shipped in the web bundle) could read/write them through
-- /rest/v1. Audit (2026-10-02): no client uses the anon/authenticated key for data access:
--   * web/ uses supabase-js ONLY for supabase.auth.* (no .from/.rpc/.storage anywhere),
--   * ios/ and android/ contain no Supabase SDK or key (auth + uploads go via the backend / signed URLs),
--   * the backend (and outreach-engine, feature-harness) use the service_role key, which bypasses RLS.
--   * Supabase edge logs (2026-09-29..10-02): zero anon/authenticated /rest/v1 data requests.
-- So every table below becomes service_role-only, same pattern as 029.
--
-- Idempotent: safe to run repeatedly. Rollback: ../rollbacks/030_rollback.sql.
-- (Rollbacks live OUTSIDE supabase/migrations/ on purpose: `supabase db push`
-- applies every *.sql whose name matches <version>_name.sql, including
-- *_rollback.sql, which would undo this migration.)
-- NOTE: new tables created later still inherit Supabase default anon/authenticated grants; always
-- REVOKE in the creating migration.
-- ============================================================================

BEGIN;

-- app_users
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do anything on app_users" ON app_users;
CREATE POLICY "Service role can do anything on app_users" ON app_users
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON app_users FROM anon, authenticated;

-- audiobook_chapters
ALTER TABLE audiobook_chapters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on audiobook_chapters" ON audiobook_chapters;
CREATE POLICY "Service role full access on audiobook_chapters" ON audiobook_chapters
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON audiobook_chapters FROM anon, authenticated;

-- audiobooks
ALTER TABLE audiobooks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on audiobooks" ON audiobooks;
CREATE POLICY "Service role full access on audiobooks" ON audiobooks
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON audiobooks FROM anon, authenticated;

-- cloned_voices
ALTER TABLE cloned_voices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on cloned_voices" ON cloned_voices;
CREATE POLICY "Service role full access on cloned_voices" ON cloned_voices
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON cloned_voices FROM anon, authenticated;

-- daily_quota
ALTER TABLE daily_quota ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do anything on daily_quota" ON daily_quota;
CREATE POLICY "Service role can do anything on daily_quota" ON daily_quota
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON daily_quota FROM anon, authenticated;

-- latency_cache
ALTER TABLE latency_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on latency_cache" ON latency_cache;
DROP POLICY IF EXISTS "Anyone can read latency_cache" ON latency_cache;
CREATE POLICY "Service role full access on latency_cache" ON latency_cache
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON latency_cache FROM anon, authenticated;

-- latency_metrics
ALTER TABLE latency_metrics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on latency_metrics" ON latency_metrics;
CREATE POLICY "Service role full access on latency_metrics" ON latency_metrics
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON latency_metrics FROM anon, authenticated;

-- monthly_quota
ALTER TABLE monthly_quota ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do anything on monthly_quota" ON monthly_quota;
CREATE POLICY "Service role can do anything on monthly_quota" ON monthly_quota
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON monthly_quota FROM anon, authenticated;

-- shared_voices
ALTER TABLE shared_voices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on shared_voices" ON shared_voices;
CREATE POLICY "Service role full access on shared_voices" ON shared_voices
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON shared_voices FROM anon, authenticated;

-- stt_transcriptions
ALTER TABLE stt_transcriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on stt_transcriptions" ON stt_transcriptions;
CREATE POLICY "Service role full access on stt_transcriptions" ON stt_transcriptions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON stt_transcriptions FROM anon, authenticated;

-- subscriptions
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do anything on subscriptions" ON subscriptions;
CREATE POLICY "Service role can do anything on subscriptions" ON subscriptions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON subscriptions FROM anon, authenticated;

-- tts_cache
ALTER TABLE tts_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on tts_cache" ON tts_cache;
CREATE POLICY "Service role full access on tts_cache" ON tts_cache
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON tts_cache FROM anon, authenticated;

-- tts_job_texts
ALTER TABLE tts_job_texts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on tts_job_texts" ON tts_job_texts;
CREATE POLICY "Service role full access on tts_job_texts" ON tts_job_texts
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON tts_job_texts FROM anon, authenticated;

-- tts_jobs
ALTER TABLE tts_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on tts_jobs" ON tts_jobs;
CREATE POLICY "Service role full access on tts_jobs" ON tts_jobs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON tts_jobs FROM anon, authenticated;

-- tts_usage
ALTER TABLE tts_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role can do anything on tts_usage" ON tts_usage;
CREATE POLICY "Service role can do anything on tts_usage" ON tts_usage
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON tts_usage FROM anon, authenticated;

-- user_devices
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on user_devices" ON user_devices;
CREATE POLICY "Service role full access on user_devices" ON user_devices
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON user_devices FROM anon, authenticated;

-- voice_conversions
ALTER TABLE voice_conversions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_conversions" ON voice_conversions;
CREATE POLICY "Service role full access on voice_conversions" ON voice_conversions
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_conversions FROM anon, authenticated;

-- voice_creator_rewards
ALTER TABLE voice_creator_rewards ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_creator_rewards" ON voice_creator_rewards;
CREATE POLICY "Service role full access on voice_creator_rewards" ON voice_creator_rewards
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_creator_rewards FROM anon, authenticated;

-- voice_design_jobs
ALTER TABLE voice_design_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_design_jobs" ON voice_design_jobs;
CREATE POLICY "Service role full access on voice_design_jobs" ON voice_design_jobs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_design_jobs FROM anon, authenticated;

-- voice_design_presets
ALTER TABLE voice_design_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_design_presets" ON voice_design_presets;
CREATE POLICY "Service role full access on voice_design_presets" ON voice_design_presets
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_design_presets FROM anon, authenticated;

-- voice_isolations
ALTER TABLE voice_isolations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_isolations" ON voice_isolations;
CREATE POLICY "Service role full access on voice_isolations" ON voice_isolations
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_isolations FROM anon, authenticated;

-- voice_ratings
ALTER TABLE voice_ratings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_ratings" ON voice_ratings;
CREATE POLICY "Service role full access on voice_ratings" ON voice_ratings
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_ratings FROM anon, authenticated;

-- voice_reports
ALTER TABLE voice_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on voice_reports" ON voice_reports;
CREATE POLICY "Service role full access on voice_reports" ON voice_reports
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON voice_reports FROM anon, authenticated;

-- xtts_cloned_voices
ALTER TABLE xtts_cloned_voices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on xtts_cloned_voices" ON xtts_cloned_voices;
CREATE POLICY "Service role full access on xtts_cloned_voices" ON xtts_cloned_voices
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON xtts_cloned_voices FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- Section B: SECURITY DEFINER function callable by anon (bypasses the table locks above).
-- get_user_by_device(text) returns a user for a device id and runs as owner, so anon could read
-- user_devices through it. The backend calls nothing here via the anon key.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_user_by_device(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_by_device(text) TO service_role;

-- ----------------------------------------------------------------------------
-- Section C: defense in depth, no behaviour change. These tables are already protected by RLS
-- (no policy, or SELECT-only policies) but still hold DML/TRUNCATE grants for anon/authenticated.
-- ----------------------------------------------------------------------------
REVOKE ALL ON music_api_keys, music_jobs, sound_effect_jobs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON voices FROM anon, authenticated;

COMMIT;
