-- ============================================================================
-- Migration: Add TTS Jobs and Cache Tables (Fix version - skips existing types)
-- ============================================================================

-- Skip CREATE TYPE statements since they already exist

-- ============================================================================
-- TTS Jobs Table (if not exists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tts_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    status tts_job_status NOT NULL DEFAULT 'queued',
    voice_id TEXT NOT NULL,
    model_id TEXT DEFAULT 'kokoro-82m',
    speed DECIMAL(3,2) DEFAULT 1.0,
    format audio_format DEFAULT 'mp3',
    input_text_hash TEXT,
    input_char_count INTEGER NOT NULL,
    cache_key TEXT NOT NULL,
    audio_path TEXT,
    audio_url TEXT,
    audio_url_expires_at TIMESTAMPTZ,
    duration_sec INTEGER,
    progress_sec INTEGER DEFAULT 0,
    chunks_total INTEGER,
    chunks_completed INTEGER DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    article_id UUID,
    article_title TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- ============================================================================
-- TTS Cache Table (if not exists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tts_cache (
    cache_key TEXT PRIMARY KEY,
    audio_path TEXT NOT NULL,
    format audio_format NOT NULL,
    duration_sec INTEGER NOT NULL,
    file_size_bytes INTEGER,
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    speed DECIMAL(3,2) NOT NULL,
    hits INTEGER DEFAULT 0,
    last_hit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    text_hash TEXT NOT NULL
);

-- ============================================================================
-- Indexes (IF NOT EXISTS)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_tts_jobs_user_id ON tts_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_tts_jobs_status ON tts_jobs(status);
CREATE INDEX IF NOT EXISTS idx_tts_jobs_queued ON tts_jobs(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_tts_jobs_cache_key ON tts_jobs(cache_key);
CREATE INDEX IF NOT EXISTS idx_tts_jobs_user_created ON tts_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tts_jobs_article ON tts_jobs(article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tts_cache_voice_model ON tts_cache(voice_id, model_id);
CREATE INDEX IF NOT EXISTS idx_tts_cache_lru ON tts_cache(last_hit_at NULLS FIRST, hits);
CREATE INDEX IF NOT EXISTS idx_tts_cache_text_hash ON tts_cache(text_hash);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE tts_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_cache ENABLE ROW LEVEL SECURITY;

-- Drop and recreate policies (safe to run multiple times)
DROP POLICY IF EXISTS "Service role full access on tts_jobs" ON tts_jobs;
DROP POLICY IF EXISTS "Service role full access on tts_cache" ON tts_cache;
CREATE POLICY "Service role full access on tts_jobs" ON tts_jobs FOR ALL USING (true);
CREATE POLICY "Service role full access on tts_cache" ON tts_cache FOR ALL USING (true);

-- ============================================================================
-- Functions (CREATE OR REPLACE is idempotent)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_cached_audio(p_cache_key TEXT)
RETURNS TABLE (
    audio_path TEXT,
    duration_sec INTEGER,
    format audio_format,
    hit_count INTEGER
) AS $$
BEGIN
    UPDATE tts_cache
    SET hits = hits + 1,
        last_hit_at = NOW()
    WHERE cache_key = p_cache_key;

    RETURN QUERY
    SELECT c.audio_path, c.duration_sec, c.format, c.hits
    FROM tts_cache c
    WHERE c.cache_key = p_cache_key;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION upsert_cache_entry(
    p_cache_key TEXT,
    p_audio_path TEXT,
    p_format audio_format,
    p_duration_sec INTEGER,
    p_file_size_bytes INTEGER,
    p_voice_id TEXT,
    p_model_id TEXT,
    p_speed DECIMAL,
    p_text_hash TEXT
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO tts_cache (
        cache_key, audio_path, format, duration_sec, file_size_bytes,
        voice_id, model_id, speed, text_hash, hits, last_hit_at
    )
    VALUES (
        p_cache_key, p_audio_path, p_format, p_duration_sec, p_file_size_bytes,
        p_voice_id, p_model_id, p_speed, p_text_hash, 1, NOW()
    )
    ON CONFLICT (cache_key) DO UPDATE SET
        audio_path = EXCLUDED.audio_path,
        duration_sec = EXCLUDED.duration_sec,
        file_size_bytes = EXCLUDED.file_size_bytes,
        hits = tts_cache.hits + 1,
        last_hit_at = NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_next_tts_job()
RETURNS TABLE (
    job_id UUID,
    user_id UUID,
    voice_id TEXT,
    model_id TEXT,
    speed DECIMAL,
    format audio_format,
    cache_key TEXT,
    input_char_count INTEGER
) AS $$
DECLARE
    v_job_id UUID;
BEGIN
    SELECT id INTO v_job_id
    FROM tts_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    UPDATE tts_jobs
    SET status = 'processing',
        started_at = NOW(),
        updated_at = NOW()
    WHERE id = v_job_id;

    RETURN QUERY
    SELECT j.id, j.user_id, j.voice_id, j.model_id, j.speed, j.format, j.cache_key, j.input_char_count
    FROM tts_jobs j
    WHERE j.id = v_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_job_progress(
    p_job_id UUID,
    p_status tts_job_status,
    p_progress_sec INTEGER DEFAULT NULL,
    p_chunks_completed INTEGER DEFAULT NULL,
    p_audio_path TEXT DEFAULT NULL,
    p_duration_sec INTEGER DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    UPDATE tts_jobs
    SET status = p_status,
        progress_sec = COALESCE(p_progress_sec, progress_sec),
        chunks_completed = COALESCE(p_chunks_completed, chunks_completed),
        audio_path = COALESCE(p_audio_path, audio_path),
        duration_sec = COALESCE(p_duration_sec, duration_sec),
        error_code = COALESCE(p_error_code, error_code),
        error_message = COALESCE(p_error_message, error_message),
        updated_at = NOW(),
        completed_at = CASE WHEN p_status IN ('ready', 'failed', 'canceled') THEN NOW() ELSE completed_at END
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Trigger
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tts_jobs_updated_at ON tts_jobs;
CREATE TRIGGER tts_jobs_updated_at
    BEFORE UPDATE ON tts_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
