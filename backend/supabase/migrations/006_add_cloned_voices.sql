-- ============================================================================
-- Migration: Add Cloned Voices Table and Storage Setup
-- Supports voice cloning with Chatterbox TTS model
-- ============================================================================

-- ============================================================================
-- Cloned Voices Table
-- Stores metadata for user-created voice clones
-- ============================================================================

CREATE TABLE cloned_voices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- User association
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Voice metadata
    name TEXT NOT NULL,                      -- User-given name for the voice
    description TEXT,                        -- Optional description

    -- Reference audio storage
    -- Audio files stored in Supabase Storage: cloned_voices/{user_id}/{voice_id}.wav
    audio_path TEXT NOT NULL,                -- Supabase Storage path
    audio_url TEXT,                          -- Cached signed URL (optional, expires)
    audio_url_expires_at TIMESTAMPTZ,        -- When the signed URL expires

    -- Audio metadata
    duration_sec DECIMAL(8,2),               -- Duration of reference audio
    file_size_bytes INTEGER,                 -- File size in bytes
    sample_rate INTEGER DEFAULT 24000,       -- Audio sample rate (Chatterbox uses 24kHz)

    -- Voice clone settings (for Chatterbox)
    exaggeration DECIMAL(3,2) DEFAULT 0.5,   -- Emotion/style exaggeration (0.0-1.0)

    -- Status
    is_active BOOLEAN DEFAULT true,          -- Whether voice is available for use
    is_default BOOLEAN DEFAULT false,        -- User's default cloned voice

    -- Usage tracking
    usage_count INTEGER DEFAULT 0,           -- Number of times used for synthesis
    last_used_at TIMESTAMPTZ,                -- Last time used for synthesis

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- User's voices (most common query)
CREATE INDEX idx_cloned_voices_user_id ON cloned_voices(user_id);

-- User's active voices
CREATE INDEX idx_cloned_voices_user_active ON cloned_voices(user_id)
    WHERE is_active = true;

-- User's default voice
CREATE UNIQUE INDEX idx_cloned_voices_user_default ON cloned_voices(user_id)
    WHERE is_default = true;

-- Recently used voices (for LRU caching on TTS service)
CREATE INDEX idx_cloned_voices_last_used ON cloned_voices(last_used_at DESC NULLS LAST);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE cloned_voices ENABLE ROW LEVEL SECURITY;

-- Users can view their own voices
CREATE POLICY "Users can view own voices" ON cloned_voices
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own voices
CREATE POLICY "Users can insert own voices" ON cloned_voices
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own voices
CREATE POLICY "Users can update own voices" ON cloned_voices
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own voices
CREATE POLICY "Users can delete own voices" ON cloned_voices
    FOR DELETE
    USING (auth.uid() = user_id);

-- Service role has full access (for backend operations)
CREATE POLICY "Service role full access on cloned_voices" ON cloned_voices
    FOR ALL
    USING (true);

-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Get user's active cloned voices
CREATE OR REPLACE FUNCTION get_user_cloned_voices(p_user_id UUID)
RETURNS TABLE (
    id UUID,
    name TEXT,
    description TEXT,
    audio_path TEXT,
    audio_url TEXT,
    duration_sec DECIMAL,
    exaggeration DECIMAL,
    is_default BOOLEAN,
    usage_count INTEGER,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cv.id,
        cv.name,
        cv.description,
        cv.audio_path,
        cv.audio_url,
        cv.duration_sec,
        cv.exaggeration,
        cv.is_default,
        cv.usage_count,
        cv.created_at
    FROM cloned_voices cv
    WHERE cv.user_id = p_user_id
      AND cv.is_active = true
    ORDER BY cv.is_default DESC, cv.usage_count DESC, cv.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Function: Set a voice as user's default (unset others)
CREATE OR REPLACE FUNCTION set_default_cloned_voice(
    p_user_id UUID,
    p_voice_id UUID
)
RETURNS BOOLEAN AS $$
BEGIN
    -- Unset current default
    UPDATE cloned_voices
    SET is_default = false, updated_at = NOW()
    WHERE user_id = p_user_id AND is_default = true;

    -- Set new default
    UPDATE cloned_voices
    SET is_default = true, updated_at = NOW()
    WHERE id = p_voice_id AND user_id = p_user_id AND is_active = true;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function: Record voice usage (called when synthesis uses a cloned voice)
CREATE OR REPLACE FUNCTION record_cloned_voice_usage(p_voice_id UUID)
RETURNS VOID AS $$
BEGIN
    UPDATE cloned_voices
    SET usage_count = usage_count + 1,
        last_used_at = NOW(),
        updated_at = NOW()
    WHERE id = p_voice_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Get voice details with fresh signed URL
CREATE OR REPLACE FUNCTION get_cloned_voice_for_synthesis(
    p_voice_id UUID,
    p_user_id UUID
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    audio_path TEXT,
    exaggeration DECIMAL,
    sample_rate INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        cv.id,
        cv.name,
        cv.audio_path,
        cv.exaggeration,
        cv.sample_rate
    FROM cloned_voices cv
    WHERE cv.id = p_voice_id
      AND cv.user_id = p_user_id
      AND cv.is_active = true;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Trigger: Auto-update updated_at
-- ============================================================================

CREATE TRIGGER cloned_voices_updated_at
    BEFORE UPDATE ON cloned_voices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Add cloned_voice_id to tts_jobs for tracking
-- ============================================================================

ALTER TABLE tts_jobs
    ADD COLUMN IF NOT EXISTS cloned_voice_id UUID REFERENCES cloned_voices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tts_jobs_cloned_voice ON tts_jobs(cloned_voice_id)
    WHERE cloned_voice_id IS NOT NULL;

-- ============================================================================
-- Storage Bucket Setup (run manually in Supabase Dashboard or via API)
-- ============================================================================

-- Note: Create a storage bucket named 'cloned_voices' with the following settings:
-- - Public: false (private bucket)
-- - File size limit: 10MB
-- - Allowed MIME types: audio/wav, audio/wave, audio/x-wav, audio/mpeg, audio/mp3
--
-- Storage policies (set via Supabase Dashboard):
-- 1. Users can upload to their own folder: cloned_voices/{user_id}/*
-- 2. Users can read their own files: cloned_voices/{user_id}/*
-- 3. Users can delete their own files: cloned_voices/{user_id}/*
-- 4. Service role has full access

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE cloned_voices IS
    'Stores metadata for user-created voice clones using Chatterbox TTS.
     Reference audio files are stored in Supabase Storage bucket ''cloned_voices''.';

COMMENT ON COLUMN cloned_voices.exaggeration IS
    'Chatterbox emotion/style exaggeration parameter (0.0-1.0).
     Lower values are more neutral, higher values more expressive.';

COMMENT ON COLUMN cloned_voices.audio_path IS
    'Supabase Storage path, e.g., ''cloned_voices/{user_id}/{voice_id}.wav''';
