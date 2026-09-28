-- ============================================================================
-- Migration: Add XTTS v2 Instant Cloned Voices Table
-- ============================================================================

CREATE TABLE xtts_cloned_voices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User association (Supabase auth user, same as voice-design/voice-convert)
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Modal voice ID (deterministic hash from XTTS clone endpoint, e.g. x-987b950ea40c)
    modal_voice_id TEXT NOT NULL,

    -- Voice metadata
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    reference_seconds DECIMAL(6,2),          -- Duration of reference audio

    -- Status
    status TEXT NOT NULL DEFAULT 'ready',     -- 'ready' | 'failed'

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Prevent duplicate (user, voice) pairs — re-uploading same reference gives same modal_voice_id
CREATE UNIQUE INDEX idx_xtts_cloned_voices_user_modal
    ON xtts_cloned_voices(user_id, modal_voice_id);

-- Fast user listing
CREATE INDEX idx_xtts_cloned_voices_user_id
    ON xtts_cloned_voices(user_id, created_at DESC);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE xtts_cloned_voices ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend handles authorization via JWT)
CREATE POLICY "Service role full access on xtts_cloned_voices" ON xtts_cloned_voices
    FOR ALL USING (true);

-- ============================================================================
-- Trigger: Auto-update updated_at
-- ============================================================================

CREATE TRIGGER xtts_cloned_voices_updated_at
    BEFORE UPDATE ON xtts_cloned_voices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE xtts_cloned_voices IS
    'Stores metadata for XTTS v2 instant-cloned voices. Reference audio and speaker embeddings live on the Modal volume; this table only tracks ownership and naming.';

COMMENT ON COLUMN xtts_cloned_voices.modal_voice_id IS
    'Deterministic voice ID returned by the XTTS Modal app (hash of reference audio bytes).';
