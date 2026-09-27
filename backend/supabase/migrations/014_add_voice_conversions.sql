-- ============================================================================
-- Voice Conversion Tables
-- Migration: 014_add_voice_conversions.sql
-- Enables users to convert speech from one voice to another via Seed-VC
-- ============================================================================

-- ============================================================================
-- Voice Conversions - Track speech-to-speech conversions for billing/auditing
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_conversions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    modal_job_id TEXT NOT NULL,
    source_seconds DECIMAL(6,2),
    target_seconds DECIMAL(6,2),
    status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed', 'rejected')),
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_voice_conversions_user ON voice_conversions(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_conversions_status ON voice_conversions(status);

-- RLS
ALTER TABLE voice_conversions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_conversions" ON voice_conversions
    FOR ALL USING (true);

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE voice_conversions IS
    'Tracks speech-to-speech voice conversions for user history, auditing, and billing.';
