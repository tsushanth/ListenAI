-- ============================================================================
-- Migration: Add Audiobooks MVP Tables
-- ============================================================================
-- Chapter-detected, batch same-voice TTS audiobook generation.
-- One `audiobooks` row per requested audiobook, fanning out to one
-- `audiobook_chapters` row per detected chapter. Each chapter reuses the
-- existing tts_jobs pipeline (one tts_jobs row per chapter, referenced via
-- tts_job_id) rather than duplicating synthesis/queueing logic.

CREATE TABLE audiobooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User association (Supabase auth user, same convention as xtts_cloned_voices)
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    title TEXT NOT NULL,

    -- Fixed voice/synthesis settings applied to every chapter job
    voice_id TEXT NOT NULL,
    speed DECIMAL(3,2) NOT NULL DEFAULT 1.0,

    -- Where the source text came from
    source_type TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'epub'

    -- Overall lifecycle status, rolled up from chapter/job statuses
    -- 'pending'    - created, chapter detection + job fan-out not finished
    -- 'processing' - chapter jobs are running
    -- 'completed'  - all chapters synthesized (export may or may not have run yet)
    -- 'failed'     - chapter detection failed, or one or more chapter jobs failed terminally
    status TEXT NOT NULL DEFAULT 'pending',

    chapter_count INTEGER NOT NULL DEFAULT 0,

    -- Populated once the export endpoint has concatenated chapters into a single file
    export_status TEXT NOT NULL DEFAULT 'not_started',  -- 'not_started' | 'processing' | 'completed' | 'failed'
    export_audio_path TEXT,          -- Storage path of the concatenated MP3 (with ID3 chapter markers)
    export_duration_sec INTEGER,

    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audiobooks_user_id
    ON audiobooks(user_id, created_at DESC);

CREATE TABLE audiobook_chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    audiobook_id UUID NOT NULL REFERENCES audiobooks(id) ON DELETE CASCADE,

    -- 0-based ordering within the audiobook
    sequence INTEGER NOT NULL,

    title TEXT,
    text_content TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,

    -- References the tts_jobs row doing the actual synthesis for this chapter.
    -- Not a FK (tts_jobs rows can be created via RPC without a hard schema
    -- dependency here, and tts_jobs may prune/rotate independently) but is
    -- always a tts_jobs.id when set.
    tts_job_id UUID,

    -- Mirrors the underlying tts_jobs status so the aggregate status endpoint
    -- can roll up without joining tts_jobs on every poll.
    -- 'pending' | 'queued' | 'processing' | 'ready' | 'failed' | 'canceled'
    status TEXT NOT NULL DEFAULT 'pending',

    audio_path TEXT,
    duration_seconds INTEGER,

    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT audiobook_chapters_unique_sequence UNIQUE (audiobook_id, sequence)
);

CREATE INDEX idx_audiobook_chapters_audiobook_id
    ON audiobook_chapters(audiobook_id, sequence);

CREATE INDEX idx_audiobook_chapters_tts_job_id
    ON audiobook_chapters(tts_job_id);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE audiobooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audiobook_chapters ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend handles authorization via JWT),
-- matching the posture in migration 017_add_xtts_cloned_voices.sql.
CREATE POLICY "Service role full access on audiobooks" ON audiobooks
    FOR ALL USING (true);

CREATE POLICY "Service role full access on audiobook_chapters" ON audiobook_chapters
    FOR ALL USING (true);

-- ============================================================================
-- Triggers: Auto-update updated_at
-- ============================================================================

CREATE TRIGGER audiobooks_updated_at
    BEFORE UPDATE ON audiobooks
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER audiobook_chapters_updated_at
    BEFORE UPDATE ON audiobook_chapters
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE audiobooks IS
    'Audiobooks MVP: one row per user-requested audiobook (long text or ePub), chapter-detected and synthesized chapter-by-chapter with a single fixed voice/speed.';

COMMENT ON TABLE audiobook_chapters IS
    'One row per detected chapter of an audiobook. Each chapter fans out to its own tts_jobs row (tts_job_id) reusing the existing TTS job pipeline; status mirrors that job until export.';

COMMENT ON COLUMN audiobook_chapters.tts_job_id IS
    'ID of the tts_jobs row doing synthesis for this chapter. Not a foreign key by design — see table comment.';
