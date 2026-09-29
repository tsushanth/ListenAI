-- Voice isolation (vocal separation via Demucs) tables.
-- Mirrors 016_user_voice_convert_deployments.sql's shape: the backend deploys/destroys Modal apps
-- on behalf of users for GPU self-serve, same as voice-convert.

CREATE TABLE user_voice_isolate_deployments (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  modal_url TEXT NOT NULL,
  modal_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'deploying', -- deploying, ready, stopping, stopped, failed
  job_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_voice_isolate_deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own isolate deployment"
  ON user_voice_isolate_deployments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own isolate deployment"
  ON user_voice_isolate_deployments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own isolate deployment"
  ON user_voice_isolate_deployments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own isolate deployment"
  ON user_voice_isolate_deployments FOR DELETE
  USING (auth.uid() = user_id);

-- ============================================================================
-- Voice Isolations - Track vocal-isolation jobs for billing/auditing
-- Mirrors 014_add_voice_conversions.sql's voice_conversions table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_isolations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    modal_job_id TEXT NOT NULL,
    input_seconds DECIMAL(6,2),
    want_instrumental BOOLEAN DEFAULT false,
    status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'failed', 'rejected')),
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_voice_isolations_user ON voice_isolations(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_isolations_status ON voice_isolations(status);

ALTER TABLE voice_isolations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_isolations" ON voice_isolations
    FOR ALL USING (true);

COMMENT ON TABLE voice_isolations IS
    'Tracks vocal-isolation (Demucs) jobs for user history, auditing, and billing.';
