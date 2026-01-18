-- ============================================================================
-- Migration: Add TTS Job Texts Table
-- Temporary storage for job text during processing (deleted after completion)
-- ============================================================================

-- TTS Job Texts Table
-- Stores text temporarily while job is being processed
-- Text is deleted once job completes (ready/failed/canceled)
CREATE TABLE IF NOT EXISTS tts_job_texts (
    job_id UUID PRIMARY KEY REFERENCES tts_jobs(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_tts_job_texts_created ON tts_job_texts(created_at);

-- Row Level Security
ALTER TABLE tts_job_texts ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend uses service_role key)
CREATE POLICY "Service role full access on tts_job_texts" ON tts_job_texts FOR ALL USING (true);

-- Automatic cleanup function - delete texts older than 24 hours
-- This is a safety net in case jobs fail without cleanup
CREATE OR REPLACE FUNCTION cleanup_old_job_texts()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM tts_job_texts
    WHERE created_at < NOW() - INTERVAL '24 hours';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
