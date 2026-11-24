-- backend/supabase/rollbacks/037_rollback.sql
-- Drops the request log (its indexes and policy go with it). Turn REQUEST_LOG_INGEST_ENABLED off first.
DROP TABLE IF EXISTS realtimetts_request_log;
