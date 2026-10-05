-- ============================================================================
-- Migration: STT retention controls + per-key settings
--
-- Product policy (see backend/src/routes/stt.ts): transcript TEXT is not stored by default. A row in
-- stt_transcriptions is metadata only (status, duration, language, sizes) unless the key has a retention
-- period, in which case text/words/segments are stored together with an expires_at and purged after it.
--
--   * stt_transcriptions: new metadata columns (surface, keyterm_count, retention_days, expires_at).
--   * stt_key_settings:   optional per-key (gateway key id, "key:<id>") or per-user (user id) overrides:
--                         retention_days, rate_per_min, max_concurrent. NULL = use the server default.
--   * purge_expired_stt_transcripts(): deletes rows past expires_at; scheduled hourly via pg_cron when the
--                         extension is available (otherwise call it, or purgeExpiredSttTranscripts() in
--                         routes/stt.ts, from any scheduler).
--
-- SECURITY: the new table and function are locked to service_role from the start (the same posture 029/030
-- retrofitted onto older tables): RLS on, a policy TO service_role only, all anon/authenticated grants revoked.
-- Do NOT add a permissive policy here: ReadAloud has had publicly writable tables via the anon key.
--
-- Existing rows keep whatever they already hold: this migration does NOT delete or null existing transcript
-- text. Decide separately whether to backfill expires_at / scrub rows created before this policy.
-- Rollback: backend/supabase/rollbacks/032_rollback.sql
-- ============================================================================

ALTER TABLE stt_transcriptions
    ADD COLUMN IF NOT EXISTS surface        TEXT,          -- 'api' | 'listen' | 'audio_transcriptions'
    ADD COLUMN IF NOT EXISTS keyterm_count  INTEGER,
    ADD COLUMN IF NOT EXISTS retention_days INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;   -- only set when text was stored

CREATE INDEX IF NOT EXISTS idx_stt_transcriptions_expires_at
    ON stt_transcriptions(expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON COLUMN stt_transcriptions.text IS
    'NULL unless the key has retention_days > 0 (default: transcript text is not stored). Purged at expires_at.';

-- ----------------------------------------------------------------------------
-- Per-key settings
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stt_key_settings (
    subject         TEXT PRIMARY KEY,                       -- 'key:<gateway key id>' or '<user uuid>'
    retention_days  INTEGER CHECK (retention_days IS NULL OR retention_days BETWEEN 0 AND 365),
    rate_per_min    INTEGER CHECK (rate_per_min IS NULL OR rate_per_min > 0),
    max_concurrent  INTEGER CHECK (max_concurrent IS NULL OR max_concurrent > 0),
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stt_key_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on stt_key_settings" ON stt_key_settings;
CREATE POLICY "Service role full access on stt_key_settings" ON stt_key_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON stt_key_settings FROM anon, authenticated;

COMMENT ON TABLE stt_key_settings IS
    'Optional per-key STT overrides (retention, rate limit, concurrency). Backend-only (service_role); NULL column = server default.';

-- ----------------------------------------------------------------------------
-- TTL purge
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_expired_stt_transcripts()
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    n bigint;
BEGIN
    DELETE FROM stt_transcriptions WHERE expires_at IS NOT NULL AND expires_at < NOW();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

-- Functions are executable by PUBLIC by default: lock it down.
REVOKE ALL ON FUNCTION purge_expired_stt_transcripts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purge_expired_stt_transcripts() TO service_role;

-- Hourly purge when pg_cron is installed; skipped (with a notice) otherwise.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'purge-expired-stt-transcripts';
        PERFORM cron.schedule('purge-expired-stt-transcripts', '17 * * * *', 'SELECT purge_expired_stt_transcripts()');
    ELSE
        RAISE NOTICE 'pg_cron not installed: schedule purge_expired_stt_transcripts() externally.';
    END IF;
END
$$;
