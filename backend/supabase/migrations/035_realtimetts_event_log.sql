-- backend/supabase/migrations/035_realtimetts_event_log.sql
-- Migration 035: failure log for the admin dashboard (usage-report and webhook failures).
-- NOT APPLIED until the owner runs it in the Supabase SQL editor.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as 033/034).
CREATE TABLE IF NOT EXISTS realtimetts_event_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        TEXT        NOT NULL CHECK (kind IN ('usage_report_failed', 'webhook_failed')),
    user_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
    detail      TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_event_log_kind_created ON realtimetts_event_log(kind, created_at DESC);

ALTER TABLE realtimetts_event_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_event_log" ON realtimetts_event_log;
CREATE POLICY "Service role only on realtimetts_event_log" ON realtimetts_event_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_event_log FROM anon, authenticated;
