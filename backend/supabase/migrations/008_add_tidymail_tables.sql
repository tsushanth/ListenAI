-- TidyMail Email Briefings Tables
-- Migration: 008_add_tidymail_tables.sql
-- Note: Uses device ID (TEXT) for user_id to match cloned_voices pattern

-- ============================================================================
-- Briefings Table - Stores generated podcast-style email briefings
-- ============================================================================

CREATE TABLE IF NOT EXISTS tidymail_briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,  -- Device ID from X-Device-ID header

  -- Content
  email_count INTEGER NOT NULL,
  script JSONB NOT NULL,  -- Array of {speaker, text, type} segments

  -- Audio
  audio_url TEXT,
  audio_path TEXT,  -- Storage path for cleanup
  duration_seconds INTEGER,

  -- Voice settings used
  voice_host1 TEXT NOT NULL DEFAULT 'nova',
  voice_host2 TEXT NOT NULL DEFAULT 'onyx',

  -- Metadata
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_tidymail_briefings_user_id ON tidymail_briefings(user_id);
CREATE INDEX IF NOT EXISTS idx_tidymail_briefings_created_at ON tidymail_briefings(created_at DESC);

-- RLS policies (service role has full access, auth via device ID in backend)
ALTER TABLE tidymail_briefings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on tidymail_briefings" ON tidymail_briefings
  FOR ALL
  USING (true);

-- ============================================================================
-- Email Audio Cache - Stores synthesized audio for individual email threads
-- ============================================================================

CREATE TABLE IF NOT EXISTS tidymail_email_audio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,  -- Device ID from X-Device-ID header

  -- Email identification
  account_id TEXT NOT NULL,  -- TidyMail account ID
  thread_id TEXT NOT NULL,   -- Email thread ID from provider

  -- Audio
  audio_url TEXT NOT NULL,
  audio_path TEXT NOT NULL,  -- Storage path
  duration_seconds INTEGER NOT NULL,

  -- Cache key for deduplication
  cache_key TEXT NOT NULL,
  voice_id TEXT NOT NULL DEFAULT 'alloy',
  speed NUMERIC(3, 2) NOT NULL DEFAULT 1.0,

  -- Metadata
  char_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 1,

  -- Composite unique constraint
  UNIQUE (account_id, thread_id, voice_id, speed)
);

-- Indexes for lookups
CREATE INDEX IF NOT EXISTS idx_tidymail_email_audio_user_id ON tidymail_email_audio(user_id);
CREATE INDEX IF NOT EXISTS idx_tidymail_email_audio_thread ON tidymail_email_audio(account_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_tidymail_email_audio_cache_key ON tidymail_email_audio(cache_key);

-- RLS policies (service role has full access, auth via device ID in backend)
ALTER TABLE tidymail_email_audio ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on tidymail_email_audio" ON tidymail_email_audio
  FOR ALL
  USING (true);

-- ============================================================================
-- Function to update last_accessed_at on cache hit
-- ============================================================================

CREATE OR REPLACE FUNCTION update_tidymail_audio_access()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_accessed_at = NOW();
  NEW.access_count = OLD.access_count + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Cleanup function for expired briefings (call periodically)
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_expired_tidymail_briefings()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM tidymail_briefings
  WHERE expires_at < NOW();

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
