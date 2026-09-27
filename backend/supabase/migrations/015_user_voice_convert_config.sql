-- Per-user voice-conversion Modal endpoint configuration.
-- Users deploy their own Modal app and store the URL + secret here.
CREATE TABLE user_voice_convert_configs (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  modal_url TEXT NOT NULL,
  modal_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE user_voice_convert_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own config"
  ON user_voice_convert_configs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own config"
  ON user_voice_convert_configs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own config"
  ON user_voice_convert_configs FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own config"
  ON user_voice_convert_configs FOR DELETE
  USING (auth.uid() = user_id);
