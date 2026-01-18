-- ============================================================================
-- Migration: Add Preview Audio Support
-- Adds columns for preview-first playback (preview.mp3 + full.mp3 swap)
-- ============================================================================

-- Add preview audio columns to tts_jobs
ALTER TABLE tts_jobs
ADD COLUMN IF NOT EXISTS preview_audio_path TEXT,      -- Path to preview MP3
ADD COLUMN IF NOT EXISTS preview_duration_sec INTEGER, -- Duration of preview in seconds
ADD COLUMN IF NOT EXISTS full_audio_path TEXT;         -- Path to full MP3 (separate from audio_path for clarity)

-- Update the audio_path column comment
COMMENT ON COLUMN tts_jobs.audio_path IS 'Legacy: full audio path. Use full_audio_path for new jobs.';
COMMENT ON COLUMN tts_jobs.preview_audio_path IS 'Path to preview MP3 (first 10-20 seconds)';
COMMENT ON COLUMN tts_jobs.preview_duration_sec IS 'Duration of preview audio in seconds';
COMMENT ON COLUMN tts_jobs.full_audio_path IS 'Path to complete MP3 file';

-- Create index for partial_ready jobs (iOS clients polling for preview)
CREATE INDEX IF NOT EXISTS idx_tts_jobs_partial_ready
ON tts_jobs(user_id, status)
WHERE status = 'partial_ready';
