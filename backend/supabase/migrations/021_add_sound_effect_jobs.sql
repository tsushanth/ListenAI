-- backend/supabase/migrations/018_add_sound_effect_jobs.sql
-- Sound Effects generation jobs. Mirrors music_jobs from the (unmerged)
-- text-to-music feature branch's 024_add_music_jobs.sql, which itself
-- mirrors tts_jobs (see 002_add_tts_jobs_cache.sql,
-- 007_add_cloned_voice_job_fields.sql) but simplified: no chunking/progress
-- tracking, since sound effect generation is a single Modal call per job,
-- not a multi-chunk synthesis pipeline.
--
-- Numbered 018 because 017_add_xtts_cloned_voices.sql is the highest
-- migration present on this repo's main branch — NOT a mirror of the music
-- branch's own 018/019 numbering, which was assigned on a different,
-- unmerged branch and would collide with real migrations here.

CREATE TYPE sound_effect_job_status AS ENUM ('queued', 'processing', 'ready', 'failed');

CREATE TABLE sound_effect_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    status sound_effect_job_status NOT NULL DEFAULT 'queued',

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

CREATE INDEX idx_sound_effect_jobs_cache_key ON sound_effect_jobs (cache_key) WHERE status = 'ready';
CREATE INDEX idx_sound_effect_jobs_status ON sound_effect_jobs (status) WHERE status = 'queued';

CREATE OR REPLACE FUNCTION create_sound_effect_job(
    p_user_id UUID,
    p_prompt TEXT,
    p_duration_sec INTEGER,
    p_cache_key TEXT
) RETURNS UUID AS $$
DECLARE
    v_job_id UUID;
BEGIN
    v_job_id := uuid_generate_v4();
    INSERT INTO sound_effect_jobs (id, user_id, status, prompt, duration_sec, cache_key, created_at, updated_at)
    VALUES (v_job_id, p_user_id, 'queued', p_prompt, p_duration_sec, p_cache_key, NOW(), NOW());
    RETURN v_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION claim_next_sound_effect_job() RETURNS sound_effect_jobs AS $$
DECLARE
    v_job sound_effect_jobs;
BEGIN
    SELECT * INTO v_job FROM sound_effect_jobs
    WHERE status = 'queued'
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_job.id IS NOT NULL THEN
        UPDATE sound_effect_jobs SET status = 'processing', updated_at = NOW()
        WHERE id = v_job.id
        RETURNING * INTO v_job;
    END IF;

    RETURN v_job;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_sound_effect_job_status(
    p_job_id UUID,
    p_status sound_effect_job_status,
    p_audio_path TEXT DEFAULT NULL,
    p_error_code TEXT DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE sound_effect_jobs
    SET status = p_status,
        audio_path = COALESCE(p_audio_path, audio_path),
        error_code = p_error_code,
        error_message = p_error_message,
        updated_at = NOW(),
        completed_at = CASE WHEN p_status IN ('ready', 'failed') THEN NOW() ELSE completed_at END
    WHERE id = p_job_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_sound_effect_job_for_user(p_job_id UUID, p_user_id UUID) RETURNS sound_effect_jobs AS $$
    SELECT * FROM sound_effect_jobs WHERE id = p_job_id AND user_id = p_user_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION get_cached_sound_effect(p_cache_key TEXT) RETURNS sound_effect_jobs AS $$
    SELECT * FROM sound_effect_jobs WHERE cache_key = p_cache_key AND status = 'ready' ORDER BY created_at DESC LIMIT 1;
$$ LANGUAGE sql STABLE;
