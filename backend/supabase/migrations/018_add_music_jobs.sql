-- backend/supabase/migrations/018_add_music_jobs.sql
-- Mirrors tts_jobs (see 002_add_tts_jobs_cache.sql, 007_add_cloned_voice_job_fields.sql)
-- but simplified: no chunking/progress tracking, since music generation is a
-- single Modal call per job, not a multi-chunk synthesis pipeline.

CREATE TYPE music_job_status AS ENUM ('queued', 'processing', 'ready', 'failed');

CREATE TABLE music_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    status music_job_status NOT NULL DEFAULT 'queued',

    prompt TEXT NOT NULL,
    duration_sec INTEGER NOT NULL,

    cache_key TEXT NOT NULL,
    audio_path TEXT,

    error_code TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_music_jobs_cache_key ON music_jobs (cache_key) WHERE status = 'ready';
CREATE INDEX idx_music_jobs_status ON music_jobs (status) WHERE status = 'queued';

CREATE OR REPLACE FUNCTION create_music_job(
    p_user_id UUID,
    p_prompt TEXT,
    p_duration_sec INTEGER,
    p_cache_key TEXT
) RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
BEGIN
    v_job_id := uuid_generate_v4();
    INSERT INTO music_jobs (id, user_id, status, prompt, duration_sec, cache_key, created_at, updated_at)
    VALUES (v_job_id, p_user_id, 'queued', p_prompt, p_duration_sec, p_cache_key, NOW(), NOW());
    RETURN v_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_next_music_job() RETURNS music_jobs AS $$
DECLARE
    v_job music_jobs;
BEGIN
    SELECT * INTO v_job FROM music_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job.id IS NOT NULL THEN
        UPDATE music_jobs SET status = 'processing', updated_at = NOW()
        WHERE id = v_job.id
        RETURNING * INTO v_job;
    END IF;

    RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_music_job_status(
    p_job_id UUID,
    p_status music_job_status,
    p_audio_path TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE music_jobs
    SET status = p_status,
        audio_path = COALESCE(p_audio_path, audio_path),
        error_code = p_error_code,
        error_message = p_error_message,
        updated_at = NOW(),
        completed_at = CASE WHEN p_status IN ('ready', 'failed') THEN NOW() ELSE completed_at END
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_music_job_for_user(p_job_id UUID, p_user_id UUID) RETURNS music_jobs AS $$
    SELECT * FROM music_jobs WHERE id = p_job_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_cached_music(p_cache_key TEXT) RETURNS music_jobs AS $$
    SELECT * FROM music_jobs WHERE cache_key = p_cache_key AND status = 'ready' ORDER BY created_at DESC LIMIT 1;
$$ LANGUAGE sql STABLE;
