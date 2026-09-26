-- ============================================================================
-- Voice Design Tables
-- Migration: 013_add_voice_design.sql
-- Enables users to design voices from text descriptions via Parler-TTS
-- ============================================================================

-- ============================================================================
-- Voice Design Presets - Saved descriptions users can reuse
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_design_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_design_presets_user ON voice_design_presets(user_id);

-- RLS
ALTER TABLE voice_design_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_design_presets" ON voice_design_presets
    FOR ALL USING (true);

-- ============================================================================
-- Voice Design Jobs - Track generations for billing/auditing
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_design_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    modal_job_id TEXT NOT NULL,
    description TEXT NOT NULL,
    sample_text TEXT NOT NULL,
    status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
    audio_url TEXT,
    duration_seconds DECIMAL(6,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_voice_design_jobs_user ON voice_design_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_design_jobs_status ON voice_design_jobs(status);

-- RLS
ALTER TABLE voice_design_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_design_jobs" ON voice_design_jobs
    FOR ALL USING (true);

-- ============================================================================
-- Trigger: Auto-update updated_at on presets
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_design_presets_updated_at
    BEFORE UPDATE ON voice_design_presets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE voice_design_presets IS
    'Saved voice descriptions that users can reuse for Parler-TTS generation.';

COMMENT ON TABLE voice_design_jobs IS
    'Tracks voice design generations for user history, auditing, and billing.';
