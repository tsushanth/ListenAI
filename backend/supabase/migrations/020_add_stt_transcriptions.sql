-- ============================================================================
-- Migration: Add Speech-to-Text Transcriptions Table
-- ============================================================================
-- Backs the customer-facing /api/stt route, which proxies to the external
-- worker-stt-prod Modal app (faster-whisper large-v3-turbo) via the shared
-- realtime-tts gateway's /stt/authorize hand-off. The worker call itself is
-- synchronous (no job queue on the worker side), so this table exists to give
-- the customer-facing API submission/status/result semantics anyway: a row is
-- inserted 'processing' before the upstream call and updated to 'done'/'failed'
-- once it returns, so GET /api/stt/transcriptions/:id works immediately after
-- POST even though the upstream itself never queues anything.

CREATE TABLE stt_transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User association (Supabase auth user, same as voice-design/voice-convert)
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Request metadata
    language_requested TEXT,                 -- NULL = auto-detect (what we sent upstream)
    word_timestamps BOOLEAN NOT NULL DEFAULT false,
    input_bytes INTEGER,
    input_mimetype TEXT,

    -- Result (populated once status = 'done')
    text TEXT,
    language_detected TEXT,
    language_probability DECIMAL(5,4),
    duration_seconds DECIMAL(10,2),
    words JSONB,
    segments JSONB,

    -- Status
    status TEXT NOT NULL DEFAULT 'processing',   -- 'processing' | 'done' | 'failed'
    error TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Fast user listing
CREATE INDEX idx_stt_transcriptions_user_id
    ON stt_transcriptions(user_id, created_at DESC);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE stt_transcriptions ENABLE ROW LEVEL SECURITY;

-- Service role has full access (backend handles authorization via JWT)
CREATE POLICY "Service role full access on stt_transcriptions" ON stt_transcriptions
    FOR ALL USING (true);

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE stt_transcriptions IS
    'Tracks customer-facing speech-to-text requests proxied to the external worker-stt-prod Modal app. Audio itself is never stored here or persisted upstream (worker-stt-prod does not retain uploads); only the transcript and request metadata are kept.';

COMMENT ON COLUMN stt_transcriptions.duration_seconds IS
    'Decoded audio duration reported by the worker. Billed via STT_CHARS_PER_SECOND in realtimeTtsBilling.ts, same meter as TTS characters.';
