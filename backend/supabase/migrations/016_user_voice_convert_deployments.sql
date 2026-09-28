-- Replace per-user config table with deployment tracking.
-- The backend deploys/destroys Modal apps on behalf of users.
DROP TABLE IF EXISTS user_voice_convert_configs;

CREATE TABLE user_voice_convert_deployments (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  app_name TEXT NOT NULL,
  modal_url TEXT NOT NULL,
  modal_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'deploying', -- deploying, ready, stopping, stopped, failed
  job_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_voice_convert_deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own deployment"
  ON user_voice_convert_deployments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own deployment"
  ON user_voice_convert_deployments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own deployment"
  ON user_voice_convert_deployments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own deployment"
  ON user_voice_convert_deployments FOR DELETE
  USING (auth.uid() = user_id);
