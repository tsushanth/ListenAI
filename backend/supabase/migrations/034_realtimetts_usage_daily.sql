-- backend/supabase/migrations/034_realtimetts_usage_daily.sql
-- ============================================================================
-- Migration 034: per-day API usage ledger for the admin dashboard.
-- NOT APPLIED until the owner runs it in the Supabase SQL editor.
-- Written from reportUsageToStripe (the 5-minute gateway drain) and reportSttUsage, by realtimetts_add_usage.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as migration 033).
-- ============================================================================
CREATE TABLE IF NOT EXISTS realtimetts_usage_daily (
    day            DATE             NOT NULL,                       -- UTC day
    user_id        UUID             NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    chars          BIGINT           NOT NULL DEFAULT 0,             -- paid-key characters, total across engines (gateway drain `chars`)
    piper_chars    BIGINT           NOT NULL DEFAULT 0,             -- the Piper subset of `chars`
    audio_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0,             -- batch STT audio seconds
    free_chars     BIGINT           NOT NULL DEFAULT 0,             -- free-tier characters (gateway drain `freeChars`, per owner)
    updated_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, user_id)
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_usage_daily_user ON realtimetts_usage_daily(user_id);

ALTER TABLE realtimetts_usage_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_usage_daily" ON realtimetts_usage_daily;
CREATE POLICY "Service role only on realtimetts_usage_daily" ON realtimetts_usage_daily
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_usage_daily FROM anon, authenticated;

CREATE OR REPLACE FUNCTION realtimetts_add_usage(
    p_day DATE, p_user UUID, p_chars BIGINT, p_piper BIGINT, p_audio DOUBLE PRECISION, p_free BIGINT
) RETURNS VOID
LANGUAGE sql
SET search_path = public
AS $$
    INSERT INTO realtimetts_usage_daily (day, user_id, chars, piper_chars, audio_seconds, free_chars)
    VALUES (p_day, p_user, p_chars, p_piper, p_audio, p_free)
    ON CONFLICT (day, user_id) DO UPDATE SET
        chars         = realtimetts_usage_daily.chars + EXCLUDED.chars,
        piper_chars   = realtimetts_usage_daily.piper_chars + EXCLUDED.piper_chars,
        audio_seconds = realtimetts_usage_daily.audio_seconds + EXCLUDED.audio_seconds,
        free_chars    = realtimetts_usage_daily.free_chars + EXCLUDED.free_chars,
        updated_at    = NOW();
$$;
REVOKE ALL ON FUNCTION realtimetts_add_usage(DATE, UUID, BIGINT, BIGINT, DOUBLE PRECISION, BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION realtimetts_add_usage(DATE, UUID, BIGINT, BIGINT, DOUBLE PRECISION, BIGINT) TO service_role;
