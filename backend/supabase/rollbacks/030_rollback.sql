-- ============================================================================
-- Rollback for 030_lock_open_tables.sql: restores the previous OPEN policies and grants
-- (FOR ALL TO PUBLIC USING (true) + full anon/authenticated grants). Re-opens the security hole;
-- use only to recover from an outage caused by 030. Idempotent.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Service role can do anything on app_users" ON app_users;
CREATE POLICY "Service role can do anything on app_users" ON app_users FOR ALL TO public USING (true);
GRANT ALL ON app_users TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on audiobook_chapters" ON audiobook_chapters;
CREATE POLICY "Service role full access on audiobook_chapters" ON audiobook_chapters FOR ALL TO public USING (true);
GRANT ALL ON audiobook_chapters TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on audiobooks" ON audiobooks;
CREATE POLICY "Service role full access on audiobooks" ON audiobooks FOR ALL TO public USING (true);
GRANT ALL ON audiobooks TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on cloned_voices" ON cloned_voices;
CREATE POLICY "Service role full access on cloned_voices" ON cloned_voices FOR ALL TO public USING (true);
GRANT ALL ON cloned_voices TO anon, authenticated;

DROP POLICY IF EXISTS "Service role can do anything on daily_quota" ON daily_quota;
CREATE POLICY "Service role can do anything on daily_quota" ON daily_quota FOR ALL TO public USING (true);
GRANT ALL ON daily_quota TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on latency_cache" ON latency_cache;
CREATE POLICY "Service role full access on latency_cache" ON latency_cache FOR ALL TO public USING (true);
DROP POLICY IF EXISTS "Anyone can read latency_cache" ON latency_cache;
CREATE POLICY "Anyone can read latency_cache" ON latency_cache FOR SELECT TO public USING (true);
GRANT ALL ON latency_cache TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on latency_metrics" ON latency_metrics;
CREATE POLICY "Service role full access on latency_metrics" ON latency_metrics FOR ALL TO public USING (true);
GRANT ALL ON latency_metrics TO anon, authenticated;

DROP POLICY IF EXISTS "Service role can do anything on monthly_quota" ON monthly_quota;
CREATE POLICY "Service role can do anything on monthly_quota" ON monthly_quota FOR ALL TO public USING (true);
GRANT ALL ON monthly_quota TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on shared_voices" ON shared_voices;
CREATE POLICY "Service role full access on shared_voices" ON shared_voices FOR ALL TO public USING (true);
GRANT ALL ON shared_voices TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on stt_transcriptions" ON stt_transcriptions;
CREATE POLICY "Service role full access on stt_transcriptions" ON stt_transcriptions FOR ALL TO public USING (true);
GRANT ALL ON stt_transcriptions TO anon, authenticated;

DROP POLICY IF EXISTS "Service role can do anything on subscriptions" ON subscriptions;
CREATE POLICY "Service role can do anything on subscriptions" ON subscriptions FOR ALL TO public USING (true);
GRANT ALL ON subscriptions TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on tts_cache" ON tts_cache;
CREATE POLICY "Service role full access on tts_cache" ON tts_cache FOR ALL TO public USING (true);
GRANT ALL ON tts_cache TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on tts_job_texts" ON tts_job_texts;
CREATE POLICY "Service role full access on tts_job_texts" ON tts_job_texts FOR ALL TO public USING (true);
GRANT ALL ON tts_job_texts TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on tts_jobs" ON tts_jobs;
CREATE POLICY "Service role full access on tts_jobs" ON tts_jobs FOR ALL TO public USING (true);
GRANT ALL ON tts_jobs TO anon, authenticated;

DROP POLICY IF EXISTS "Service role can do anything on tts_usage" ON tts_usage;
CREATE POLICY "Service role can do anything on tts_usage" ON tts_usage FOR ALL TO public USING (true);
GRANT ALL ON tts_usage TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on user_devices" ON user_devices;
CREATE POLICY "Service role full access on user_devices" ON user_devices FOR ALL TO public USING (true);
GRANT ALL ON user_devices TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_conversions" ON voice_conversions;
CREATE POLICY "Service role full access on voice_conversions" ON voice_conversions FOR ALL TO public USING (true);
GRANT ALL ON voice_conversions TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_creator_rewards" ON voice_creator_rewards;
CREATE POLICY "Service role full access on voice_creator_rewards" ON voice_creator_rewards FOR ALL TO public USING (true);
GRANT ALL ON voice_creator_rewards TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_design_jobs" ON voice_design_jobs;
CREATE POLICY "Service role full access on voice_design_jobs" ON voice_design_jobs FOR ALL TO public USING (true);
GRANT ALL ON voice_design_jobs TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_design_presets" ON voice_design_presets;
CREATE POLICY "Service role full access on voice_design_presets" ON voice_design_presets FOR ALL TO public USING (true);
GRANT ALL ON voice_design_presets TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_isolations" ON voice_isolations;
CREATE POLICY "Service role full access on voice_isolations" ON voice_isolations FOR ALL TO public USING (true);
GRANT ALL ON voice_isolations TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_ratings" ON voice_ratings;
CREATE POLICY "Service role full access on voice_ratings" ON voice_ratings FOR ALL TO public USING (true);
GRANT ALL ON voice_ratings TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on voice_reports" ON voice_reports;
CREATE POLICY "Service role full access on voice_reports" ON voice_reports FOR ALL TO public USING (true);
GRANT ALL ON voice_reports TO anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on xtts_cloned_voices" ON xtts_cloned_voices;
CREATE POLICY "Service role full access on xtts_cloned_voices" ON xtts_cloned_voices FOR ALL TO public USING (true);
GRANT ALL ON xtts_cloned_voices TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_user_by_device(text) TO PUBLIC, anon, authenticated;
GRANT ALL ON music_api_keys, music_jobs, sound_effect_jobs TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON voices TO anon, authenticated;

COMMIT;
