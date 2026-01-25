-- ============================================================================
-- Voice Marketplace Tables
-- Migration: 009_add_voice_marketplace.sql
-- Enables users to share cloned voices publicly with AI-moderated reporting
-- ============================================================================

-- ============================================================================
-- Shared Voices Table - Voices published to the marketplace
-- ============================================================================

CREATE TABLE IF NOT EXISTS shared_voices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,  -- Device ID from X-Device-ID header
    cloned_voice_id UUID NOT NULL REFERENCES cloned_voices(id) ON DELETE CASCADE,

    -- Metadata
    display_name TEXT NOT NULL,
    description TEXT,
    tags TEXT[] DEFAULT '{}',  -- ['calm', 'male', 'american', 'narrator']

    -- Sample audio for preview (short clip)
    preview_audio_path TEXT,
    preview_audio_url TEXT,
    preview_duration_sec DECIMAL(6,2),

    -- Sharing settings
    is_public BOOLEAN DEFAULT true,

    -- Legal
    terms_accepted_at TIMESTAMPTZ NOT NULL,
    owner_attestation TEXT NOT NULL,  -- "I confirm this is my own voice"

    -- Stats
    usage_count INTEGER DEFAULT 0,
    rating_sum INTEGER DEFAULT 0,
    rating_count INTEGER DEFAULT 0,

    -- Status
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked', 'pending_review')),
    revoked_at TIMESTAMPTZ,
    revoked_reason TEXT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shared_voices_owner ON shared_voices(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_shared_voices_cloned_voice ON shared_voices(cloned_voice_id);
CREATE INDEX IF NOT EXISTS idx_shared_voices_status ON shared_voices(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_voices_popular ON shared_voices(usage_count DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_voices_tags ON shared_voices USING GIN(tags);

-- Ensure one shared listing per cloned voice
CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_voices_unique_voice ON shared_voices(cloned_voice_id)
    WHERE status IN ('active', 'pending_review');

-- RLS
ALTER TABLE shared_voices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on shared_voices" ON shared_voices
    FOR ALL USING (true);

-- ============================================================================
-- Voice Reports Table - User reports for moderation
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shared_voice_id UUID NOT NULL REFERENCES shared_voices(id) ON DELETE CASCADE,
    reporter_user_id TEXT NOT NULL,  -- Device ID

    -- Report details
    reason TEXT NOT NULL CHECK (reason IN ('not_their_voice', 'celebrity', 'public_figure', 'offensive', 'copyright', 'other')),
    description TEXT NOT NULL,
    evidence_urls TEXT[] DEFAULT '{}',  -- Optional links to proof

    -- AI analysis
    ai_analysis JSONB,  -- { verdict, confidence, reasoning, detected_issues }
    ai_analyzed_at TIMESTAMPTZ,

    -- Resolution
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ai_reviewed', 'upheld', 'dismissed', 'escalated')),
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,  -- 'ai_auto' or admin identifier
    resolution_notes TEXT,

    -- Action taken
    action_taken TEXT CHECK (action_taken IN ('none', 'warning', 'suspended', 'revoked')),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_voice_reports_shared_voice ON voice_reports(shared_voice_id);
CREATE INDEX IF NOT EXISTS idx_voice_reports_reporter ON voice_reports(reporter_user_id);
CREATE INDEX IF NOT EXISTS idx_voice_reports_status ON voice_reports(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_voice_reports_created ON voice_reports(created_at DESC);

-- Prevent duplicate reports from same user for same voice
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_reports_unique_report
    ON voice_reports(shared_voice_id, reporter_user_id)
    WHERE status IN ('pending', 'ai_reviewed');

-- RLS
ALTER TABLE voice_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_reports" ON voice_reports
    FOR ALL USING (true);

-- ============================================================================
-- Voice Creator Rewards Table - Track incentives for sharing
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_creator_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,  -- Voice owner device ID
    shared_voice_id UUID NOT NULL REFERENCES shared_voices(id) ON DELETE CASCADE,

    -- Reward trigger
    used_by_user_id TEXT NOT NULL,  -- User who used the voice
    job_id UUID,  -- Reference to tts_jobs if applicable

    -- Usage details
    characters_generated INTEGER NOT NULL,
    seconds_generated DECIMAL(10,2) NOT NULL,

    -- Reward calculation
    reward_minutes DECIMAL(10,2) NOT NULL,  -- Minutes credited to owner
    reward_rate DECIMAL(4,3) DEFAULT 0.10,  -- 10% default

    -- Status
    credited BOOLEAN DEFAULT false,
    credited_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_voice_rewards_owner ON voice_creator_rewards(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_voice_rewards_shared_voice ON voice_creator_rewards(shared_voice_id);
CREATE INDEX IF NOT EXISTS idx_voice_rewards_uncredited ON voice_creator_rewards(owner_user_id) WHERE credited = false;

-- RLS
ALTER TABLE voice_creator_rewards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_creator_rewards" ON voice_creator_rewards
    FOR ALL USING (true);

-- ============================================================================
-- Voice Ratings Table - User ratings for shared voices
-- ============================================================================

CREATE TABLE IF NOT EXISTS voice_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shared_voice_id UUID NOT NULL REFERENCES shared_voices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,  -- Device ID

    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review TEXT,  -- Optional review text

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- One rating per user per voice
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_ratings_unique ON voice_ratings(shared_voice_id, user_id);
CREATE INDEX IF NOT EXISTS idx_voice_ratings_voice ON voice_ratings(shared_voice_id);

-- RLS
ALTER TABLE voice_ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on voice_ratings" ON voice_ratings
    FOR ALL USING (true);

-- ============================================================================
-- Functions
-- ============================================================================

-- Function: Update shared voice stats when rating changes
CREATE OR REPLACE FUNCTION update_shared_voice_rating()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE shared_voices
        SET rating_sum = rating_sum + NEW.rating,
            rating_count = rating_count + 1,
            updated_at = NOW()
        WHERE id = NEW.shared_voice_id;
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE shared_voices
        SET rating_sum = rating_sum - OLD.rating + NEW.rating,
            updated_at = NOW()
        WHERE id = NEW.shared_voice_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE shared_voices
        SET rating_sum = rating_sum - OLD.rating,
            rating_count = rating_count - 1,
            updated_at = NOW()
        WHERE id = OLD.shared_voice_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER voice_rating_stats_trigger
    AFTER INSERT OR UPDATE OR DELETE ON voice_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_shared_voice_rating();

-- Function: Record voice usage and create reward
CREATE OR REPLACE FUNCTION record_shared_voice_usage(
    p_shared_voice_id UUID,
    p_used_by_user_id TEXT,
    p_characters INTEGER,
    p_seconds DECIMAL,
    p_job_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    v_owner_id TEXT;
    v_reward_minutes DECIMAL;
    v_reward_id UUID;
BEGIN
    -- Get owner and increment usage count
    UPDATE shared_voices
    SET usage_count = usage_count + 1,
        updated_at = NOW()
    WHERE id = p_shared_voice_id AND status = 'active'
    RETURNING owner_user_id INTO v_owner_id;

    IF v_owner_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Don't reward if owner is using their own voice
    IF v_owner_id = p_used_by_user_id THEN
        RETURN NULL;
    END IF;

    -- Calculate reward (10% of seconds as minutes)
    v_reward_minutes := (p_seconds / 60.0) * 0.10;

    -- Create reward record
    INSERT INTO voice_creator_rewards (
        owner_user_id,
        shared_voice_id,
        used_by_user_id,
        job_id,
        characters_generated,
        seconds_generated,
        reward_minutes
    ) VALUES (
        v_owner_id,
        p_shared_voice_id,
        p_used_by_user_id,
        p_job_id,
        p_characters,
        p_seconds,
        v_reward_minutes
    )
    RETURNING id INTO v_reward_id;

    RETURN v_reward_id;
END;
$$ LANGUAGE plpgsql;

-- Function: Get marketplace voices with filters
CREATE OR REPLACE FUNCTION get_marketplace_voices(
    p_tags TEXT[] DEFAULT NULL,
    p_search TEXT DEFAULT NULL,
    p_sort_by TEXT DEFAULT 'popular',  -- 'popular', 'newest', 'rating'
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    display_name TEXT,
    description TEXT,
    tags TEXT[],
    preview_audio_url TEXT,
    preview_duration_sec DECIMAL,
    usage_count INTEGER,
    avg_rating DECIMAL,
    rating_count INTEGER,
    owner_user_id TEXT,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sv.id,
        sv.display_name,
        sv.description,
        sv.tags,
        sv.preview_audio_url,
        sv.preview_duration_sec,
        sv.usage_count,
        CASE WHEN sv.rating_count > 0
             THEN ROUND(sv.rating_sum::DECIMAL / sv.rating_count, 1)
             ELSE 0 END AS avg_rating,
        sv.rating_count,
        sv.owner_user_id,
        sv.created_at
    FROM shared_voices sv
    WHERE sv.status = 'active'
      AND sv.is_public = true
      AND (p_tags IS NULL OR sv.tags && p_tags)
      AND (p_search IS NULL OR
           sv.display_name ILIKE '%' || p_search || '%' OR
           sv.description ILIKE '%' || p_search || '%')
    ORDER BY
        CASE WHEN p_sort_by = 'popular' THEN sv.usage_count END DESC NULLS LAST,
        CASE WHEN p_sort_by = 'newest' THEN sv.created_at END DESC,
        CASE WHEN p_sort_by = 'rating' THEN
            CASE WHEN sv.rating_count > 0 THEN sv.rating_sum::DECIMAL / sv.rating_count ELSE 0 END
        END DESC NULLS LAST,
        sv.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql;

-- Function: Revoke a shared voice (owner or moderation)
CREATE OR REPLACE FUNCTION revoke_shared_voice(
    p_shared_voice_id UUID,
    p_reason TEXT,
    p_revoked_by TEXT DEFAULT 'owner'
)
RETURNS BOOLEAN AS $$
BEGIN
    UPDATE shared_voices
    SET status = 'revoked',
        revoked_at = NOW(),
        revoked_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_shared_voice_id
      AND status IN ('active', 'suspended', 'pending_review');

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql;

-- Function: Get pending rewards for a user
CREATE OR REPLACE FUNCTION get_pending_rewards(p_user_id TEXT)
RETURNS TABLE (
    total_pending_minutes DECIMAL,
    reward_count INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(SUM(reward_minutes), 0)::DECIMAL,
        COUNT(*)::INTEGER
    FROM voice_creator_rewards
    WHERE owner_user_id = p_user_id
      AND credited = false;
END;
$$ LANGUAGE plpgsql;

-- Function: Credit pending rewards to user
CREATE OR REPLACE FUNCTION credit_pending_rewards(p_user_id TEXT)
RETURNS DECIMAL AS $$
DECLARE
    v_total_minutes DECIMAL;
BEGIN
    -- Get total and mark as credited
    UPDATE voice_creator_rewards
    SET credited = true,
        credited_at = NOW()
    WHERE owner_user_id = p_user_id
      AND credited = false;

    SELECT COALESCE(SUM(reward_minutes), 0)
    INTO v_total_minutes
    FROM voice_creator_rewards
    WHERE owner_user_id = p_user_id
      AND credited_at = NOW();

    RETURN v_total_minutes;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Trigger: Auto-update updated_at
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER shared_voices_updated_at
    BEFORE UPDATE ON shared_voices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER voice_ratings_updated_at
    BEFORE UPDATE ON voice_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE shared_voices IS
    'Voices shared to the public marketplace. Users can browse and use these for TTS.';

COMMENT ON TABLE voice_reports IS
    'Reports submitted by users for voice moderation. Analyzed by AI with human escalation.';

COMMENT ON TABLE voice_creator_rewards IS
    'Tracks rewards earned by voice creators when others use their shared voices.';

COMMENT ON TABLE voice_ratings IS
    'User ratings and reviews for shared voices.';

COMMENT ON COLUMN shared_voices.owner_attestation IS
    'Legal attestation from owner confirming they have rights to share this voice.';

COMMENT ON COLUMN voice_reports.ai_analysis IS
    'JSON containing AI analysis: {verdict, confidence, reasoning, detected_issues}';
