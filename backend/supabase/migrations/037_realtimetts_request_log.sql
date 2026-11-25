-- backend/supabase/migrations/037_realtimetts_request_log.sql
-- ============================================================================
-- Migration 037: request-level API log (one row per gateway request), written by POST /api/gateway/request-log.
-- NOT APPLIED until the owner runs it in the Supabase SQL editor.
-- PRIVACY: metadata only. No text, no audio, no raw keys, no user_id (the owner is resolved at query time through
-- realtimetts_api_keys.gateway_key_id). `chars` is a character COUNT. Rows are pruned after 30 days by the backend.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as 033/034/035).
-- ============================================================================
CREATE TABLE IF NOT EXISTS realtimetts_request_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts              TIMESTAMPTZ NOT NULL,                       -- when the gateway handled the request
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- when the backend stored it
    request_id      TEXT        NOT NULL,
    gateway_key_id  TEXT        NOT NULL,                       -- realtimetts_api_keys.gateway_key_id (no FK on purpose: keys can be deleted, log rows age out)
    transport       TEXT        NOT NULL CHECK (transport IN ('http', 'ws-authorize', 'stt-authorize', 'audio-authorize', 'dubbing-authorize', 'stt-batch', 'other')),
    endpoint        TEXT        NOT NULL,
    voice           TEXT,
    language        TEXT,
    chars           INTEGER     NOT NULL DEFAULT 0,             -- character count only, never the text
    outcome         TEXT        NOT NULL CHECK (outcome IN ('ok', 'auth_failed', 'rate_limited', 'quota_exceeded', 'client_error', 'server_error')),
    http_status     INTEGER     NOT NULL,
    error_code      TEXT,
    ttfb_ms         INTEGER,
    duration_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_request_log_key_ts ON realtimetts_request_log(gateway_key_id, ts);
CREATE INDEX IF NOT EXISTS idx_realtimetts_request_log_ts ON realtimetts_request_log(ts);

ALTER TABLE realtimetts_request_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_request_log" ON realtimetts_request_log;
CREATE POLICY "Service role only on realtimetts_request_log" ON realtimetts_request_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_request_log FROM anon, authenticated;

-- Retention: the backend deletes rows with ts older than 30 days (lib/requestLog.ts pruneOldRequestLog, run by the
-- same 30-minute job as pruneOldEvents, only while REQUEST_LOG_INGEST_ENABLED is on). Manual equivalent:
--   DELETE FROM realtimetts_request_log WHERE ts < NOW() - INTERVAL '30 days';
