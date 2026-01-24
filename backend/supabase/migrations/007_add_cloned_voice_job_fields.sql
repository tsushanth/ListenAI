-- ============================================================================
-- Migration: Add Cloned Voice Job Fields
-- Extends tts_jobs table to support cloned voice synthesis jobs
-- ============================================================================

-- ============================================================================
-- Add cloning model enum and columns
-- ============================================================================

-- Create enum for cloning model
CREATE TYPE cloning_model AS ENUM ('chatterbox', 'xtts');

-- Add voice_url column (URL to reference audio for cloning)
ALTER TABLE tts_jobs
    ADD COLUMN IF NOT EXISTS voice_url TEXT;

-- Add cloning_model column
ALTER TABLE tts_jobs
    ADD COLUMN IF NOT EXISTS cloning_model cloning_model;

-- ============================================================================
-- Update RPC functions for cloned voice job creation
-- ============================================================================

-- Function: Create TTS job (extended for cloned voices)
CREATE OR REPLACE FUNCTION create_tts_job(
    p_user_id UUID,
    p_voice_id TEXT,
    p_model_id TEXT,
    p_speed DECIMAL,
    p_format audio_format,
    p_input_text_hash TEXT,
    p_input_char_count INTEGER,
    p_cache_key TEXT,
    p_text TEXT,
    p_article_id UUID DEFAULT NULL,
    p_article_title TEXT DEFAULT NULL,
    p_cloned_voice_id UUID DEFAULT NULL,
    p_voice_url TEXT DEFAULT NULL,
    p_cloning_model cloning_model DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
BEGIN
    -- Generate job ID
    v_job_id := uuid_generate_v4();

    -- Create the job
    INSERT INTO tts_jobs (
        id, user_id, status, voice_id, model_id, speed, format,
        input_text_hash, input_char_count, cache_key,
        article_id, article_title,
        cloned_voice_id, voice_url, cloning_model,
        created_at, updated_at
    ) VALUES (
        v_job_id, p_user_id, 'queued', p_voice_id, p_model_id, p_speed, p_format,
        p_input_text_hash, p_input_char_count, p_cache_key,
        p_article_id, p_article_title,
        p_cloned_voice_id, p_voice_url, p_cloning_model,
        NOW(), NOW()
    );

    -- Store the text for the worker to retrieve
    INSERT INTO tts_job_texts (job_id, text, created_at)
    VALUES (v_job_id, p_text, NOW());

    RETURN v_job_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Get TTS job by ID (extended with cloned voice fields)
-- Drop existing function first to allow return type change
DROP FUNCTION IF EXISTS get_tts_job(UUID, UUID);

CREATE OR REPLACE FUNCTION get_tts_job(
    p_job_id UUID,
    p_user_id UUID DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    user_id UUID,
    status tts_job_status,
    voice_id TEXT,
    model_id TEXT,
    speed DECIMAL,
    format audio_format,
    input_text_hash TEXT,
    input_char_count INTEGER,
    cache_key TEXT,
    audio_path TEXT,
    audio_url TEXT,
    audio_url_expires_at TIMESTAMPTZ,
    duration_sec INTEGER,
    progress_sec INTEGER,
    chunks_total INTEGER,
    chunks_completed INTEGER,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER,
    article_id UUID,
    article_title TEXT,
    cloned_voice_id UUID,
    voice_url TEXT,
    cloning_model cloning_model,
    preview_audio_path TEXT,
    preview_duration_sec INTEGER,
    full_audio_path TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        j.id,
        j.user_id,
        j.status,
        j.voice_id,
        j.model_id,
        j.speed,
        j.format,
        j.input_text_hash,
        j.input_char_count,
        j.cache_key,
        j.audio_path,
        j.audio_url,
        j.audio_url_expires_at,
        j.duration_sec,
        j.progress_sec,
        j.chunks_total,
        j.chunks_completed,
        j.error_code,
        j.error_message,
        j.retry_count,
        j.article_id,
        j.article_title,
        j.cloned_voice_id,
        j.voice_url,
        j.cloning_model,
        j.preview_audio_path,
        j.preview_duration_sec,
        j.full_audio_path,
        j.created_at,
        j.updated_at,
        j.started_at,
        j.completed_at
    FROM tts_jobs j
    WHERE j.id = p_job_id
      AND (p_user_id IS NULL OR j.user_id = p_user_id);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Update claim_next_tts_job to include cloned voice fields
-- ============================================================================

-- Drop existing function first to allow return type change
DROP FUNCTION IF EXISTS claim_next_tts_job();

CREATE OR REPLACE FUNCTION claim_next_tts_job()
RETURNS TABLE (
    job_id UUID,
    user_id UUID,
    voice_id TEXT,
    model_id TEXT,
    speed DECIMAL,
    format audio_format,
    cache_key TEXT,
    input_char_count INTEGER,
    cloned_voice_id UUID,
    voice_url TEXT,
    cloning_model cloning_model
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

    -- Return job details including cloned voice fields
    RETURN QUERY
    SELECT j.id, j.user_id, j.voice_id, j.model_id, j.speed, j.format,
           j.cache_key, j.input_char_count,
           j.cloned_voice_id, j.voice_url, j.cloning_model
    FROM tts_jobs j
    WHERE j.id = v_job_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Index for efficient cloned voice job lookup
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_tts_jobs_cloning_model
    ON tts_jobs(cloning_model)
    WHERE cloning_model IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON COLUMN tts_jobs.voice_url IS
    'URL to reference audio file for voice cloning (from Supabase Storage)';

COMMENT ON COLUMN tts_jobs.cloning_model IS
    'Voice cloning model to use: chatterbox (quality) or xtts (fast)';
