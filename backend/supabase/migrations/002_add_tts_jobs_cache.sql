-- ============================================================================
-- Migration: Add TTS Jobs and Cache Tables
-- Run this to add async job tracking and audio caching to the database
-- ============================================================================

-- ============================================================================
-- ENUM Types
-- ============================================================================

-- TTS Job Status
CREATE TYPE tts_job_status AS ENUM (
    'queued',           -- Job created, waiting to be processed
    'processing',       -- Currently being synthesized
    'partial_ready',    -- Some chunks ready, streaming possible
    'ready',            -- Fully synthesized, audio available
    'failed',           -- Synthesis failed
    'canceled'          -- User canceled the job
);

-- Audio Format
CREATE TYPE audio_format AS ENUM (
    'wav',
    'mp3',
    'ogg'
);

-- ============================================================================
-- TTS Jobs Table
-- Tracks async TTS synthesis jobs for each user request
-- ============================================================================

CREATE TABLE tts_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- User association
    user_id UUID NOT NULL,

    -- Job status
    status tts_job_status NOT NULL DEFAULT 'queued',

    -- Voice configuration
    voice_id TEXT NOT NULL,              -- Kokoro voice ID (e.g., 'am_adam')
    model_id TEXT DEFAULT 'kokoro-82m',  -- Model version
    speed DECIMAL(3,2) DEFAULT 1.0,      -- Playback speed (0.5-3.0)
    format audio_format DEFAULT 'mp3',   -- Output format

    -- Input (optional - for debugging/reprocessing)
    -- Note: For privacy, consider not storing or encrypting
    input_text_hash TEXT,                -- SHA256 of normalized text (for dedup)
    input_char_count INTEGER NOT NULL,   -- Character count

    -- Cache key for deduplication
    cache_key TEXT NOT NULL,             -- SHA256(model+voice+speed+format+text_hash)

    -- Output audio
    audio_path TEXT,                     -- Supabase Storage path (e.g., 'audio/jobs/{id}.mp3')
    audio_url TEXT,                      -- Cached signed URL (optional, expires)
    audio_url_expires_at TIMESTAMPTZ,    -- When the signed URL expires

    -- Progress tracking
    duration_sec INTEGER,                -- Total audio duration in seconds
    progress_sec INTEGER DEFAULT 0,      -- Seconds of audio ready (for partial_ready)
    chunks_total INTEGER,                -- Total chunks to process
    chunks_completed INTEGER DEFAULT 0,  -- Chunks completed so far

    -- Error handling
    error_code TEXT,                     -- Error code if failed
    error_message TEXT,                  -- Human-readable error message
    retry_count INTEGER DEFAULT 0,       -- Number of retry attempts

    -- Article association (optional)
    article_id UUID,
    article_title TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,              -- When processing started
    completed_at TIMESTAMPTZ             -- When job completed (ready/failed)
);

-- ============================================================================
-- TTS Cache Table
-- Global cache for synthesized audio, shared across users
-- ============================================================================

CREATE TABLE tts_cache (
    -- Cache key is the primary identifier
    cache_key TEXT PRIMARY KEY,

    -- Audio location
    audio_path TEXT NOT NULL,            -- Supabase Storage path

    -- Audio metadata
    format audio_format NOT NULL,
    duration_sec INTEGER NOT NULL,
    file_size_bytes INTEGER,

    -- Voice/model info for cache invalidation
    voice_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    speed DECIMAL(3,2) NOT NULL,

    -- Usage statistics
    hits INTEGER DEFAULT 0,              -- Number of times served from cache
    last_hit_at TIMESTAMPTZ,             -- Last time this cache entry was used

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Text hash for verification (not the full text for privacy)
    text_hash TEXT NOT NULL
);

-- ============================================================================
-- Indexes for TTS Jobs
-- ============================================================================

-- User's jobs (most common query)
CREATE INDEX idx_tts_jobs_user_id ON tts_jobs(user_id);

-- Jobs by status (for worker polling)
CREATE INDEX idx_tts_jobs_status ON tts_jobs(status);

-- Queue ordering (oldest queued jobs first)
CREATE INDEX idx_tts_jobs_queued ON tts_jobs(created_at) WHERE status = 'queued';

-- Cache key lookup (for deduplication)
CREATE INDEX idx_tts_jobs_cache_key ON tts_jobs(cache_key);

-- User's recent jobs
CREATE INDEX idx_tts_jobs_user_created ON tts_jobs(user_id, created_at DESC);

-- Article association
CREATE INDEX idx_tts_jobs_article ON tts_jobs(article_id) WHERE article_id IS NOT NULL;

-- ============================================================================
-- Indexes for TTS Cache
-- ============================================================================

-- Voice/model lookup (for cache invalidation when model updates)
CREATE INDEX idx_tts_cache_voice_model ON tts_cache(voice_id, model_id);

-- LRU eviction (oldest, least used entries)
CREATE INDEX idx_tts_cache_lru ON tts_cache(last_hit_at NULLS FIRST, hits);

-- Text hash for collision check
CREATE INDEX idx_tts_cache_text_hash ON tts_cache(text_hash);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE tts_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_cache ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend uses service_role key)
CREATE POLICY "Service role full access on tts_jobs" ON tts_jobs FOR ALL USING (true);
CREATE POLICY "Service role full access on tts_cache" ON tts_cache FOR ALL USING (true);

-- Users can only see their own jobs via authenticated queries
-- (Backend handles this through service role, not direct client access)

-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Check if a cache entry exists and is valid
CREATE OR REPLACE FUNCTION get_cached_audio(p_cache_key TEXT)
RETURNS TABLE (
    audio_path TEXT,
    duration_sec INTEGER,
    format audio_format,
    hit_count INTEGER
) AS $$
BEGIN
    -- Update hit counter and last_hit_at
    UPDATE tts_cache
    SET hits = hits + 1,
        last_hit_at = NOW()
    WHERE cache_key = p_cache_key;

    -- Return cache entry if exists
    RETURN QUERY
    SELECT c.audio_path, c.duration_sec, c.format, c.hits
    FROM tts_cache c
    WHERE c.cache_key = p_cache_key;
END;
$$ LANGUAGE plpgsql;

-- Function: Create or update a cache entry
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

-- Function: Get next job to process (for workers)
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
    -- Select and lock the oldest queued job
    SELECT id INTO v_job_id
    FROM tts_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job_id IS NULL THEN
        RETURN;
    END IF;

    -- Update status to processing
    UPDATE tts_jobs
    SET status = 'processing',
        started_at = NOW(),
        updated_at = NOW()
    WHERE id = v_job_id;

    -- Return job details
    RETURN QUERY
    SELECT j.id, j.user_id, j.voice_id, j.model_id, j.speed, j.format, j.cache_key, j.input_char_count
    FROM tts_jobs j
    WHERE j.id = v_job_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Update job progress
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
-- Trigger: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tts_jobs_updated_at
    BEFORE UPDATE ON tts_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
