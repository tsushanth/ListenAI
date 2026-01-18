-- ============================================================================
-- ListenAI Database Schema
-- Run this in the Supabase SQL Editor to set up your database
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- ENUM Types
-- ============================================================================

CREATE TYPE subscription_tier AS ENUM ('free', 'basic', 'pro', 'unlimited');
CREATE TYPE subscription_status AS ENUM ('active', 'trialing', 'past_due', 'canceled', 'expired');
CREATE TYPE tts_provider AS ENUM ('openai', 'google', 'amazon', 'selfhosted', 'mock');
CREATE TYPE voice_gender AS ENUM ('male', 'female', 'neutral');

-- ============================================================================
-- Users Table
-- ============================================================================

CREATE TABLE app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    display_name TEXT,
    avatar_url TEXT,
    preferred_voice_id UUID,
    default_playback_speed DECIMAL(3,2) DEFAULT 1.0,
    has_completed_onboarding BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Subscriptions Table
-- ============================================================================

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    plan_id subscription_tier DEFAULT 'free',
    status subscription_status DEFAULT 'active',
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    renews_at TIMESTAMPTZ,
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- ============================================================================
-- Voices Table
-- ============================================================================

CREATE TABLE voices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    description TEXT,
    style TEXT DEFAULT 'conversational',
    category TEXT DEFAULT 'general',
    provider tts_provider NOT NULL,
    provider_voice_id TEXT NOT NULL,
    provider_model_id TEXT,
    language TEXT DEFAULT 'en-US',
    gender voice_gender,
    is_premium BOOLEAN DEFAULT FALSE,
    tier_required subscription_tier DEFAULT 'free',
    settings JSONB DEFAULT '{}',
    sample_audio_url TEXT,
    sample_text TEXT DEFAULT 'Hello, this is a sample of my voice.',
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- TTS Usage Table
-- ============================================================================

CREATE TABLE tts_usage (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    voice_id UUID,
    provider tts_provider NOT NULL,
    provider_voice_id TEXT,
    characters_used INTEGER NOT NULL,
    audio_duration_ms INTEGER,
    estimated_cost_usd DECIMAL(10,6),
    article_id UUID,
    article_title TEXT,
    success BOOLEAN DEFAULT TRUE,
    error_code TEXT,
    error_message TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Daily Quota Table
-- ============================================================================

CREATE TABLE daily_quota (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    characters_used INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, date)
);

-- ============================================================================
-- Monthly Quota Table
-- ============================================================================

CREATE TABLE monthly_quota (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    month TEXT NOT NULL, -- Format: YYYY-MM
    characters_used INTEGER DEFAULT 0,
    request_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, month)
);

-- ============================================================================
-- Latency Metrics Table
-- Stores individual latency measurements from iOS clients
-- ============================================================================

CREATE TABLE latency_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,  -- Nullable for anonymous tracking
    text_length INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    provider tts_provider DEFAULT 'selfhosted',
    voice_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Latency Cache Table
-- Stores aggregated latency statistics by text length bucket
-- ============================================================================

CREATE TABLE latency_cache (
    bucket_id TEXT PRIMARY KEY,  -- e.g., '0-500', '501-1000'
    min_length INTEGER NOT NULL,
    max_length INTEGER NOT NULL,
    avg_latency_ms INTEGER NOT NULL,
    p50_latency_ms INTEGER NOT NULL,
    p95_latency_ms INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_tts_usage_user_id ON tts_usage(user_id);
CREATE INDEX idx_tts_usage_created_at ON tts_usage(created_at);
CREATE INDEX idx_daily_quota_user_date ON daily_quota(user_id, date);
CREATE INDEX idx_monthly_quota_user_month ON monthly_quota(user_id, month);
CREATE INDEX idx_voices_provider ON voices(provider);
CREATE INDEX idx_voices_is_active ON voices(is_active);
CREATE INDEX idx_latency_metrics_text_length ON latency_metrics(text_length);
CREATE INDEX idx_latency_metrics_created_at ON latency_metrics(created_at);

-- ============================================================================
-- Function: Check if user can synthesize
-- ============================================================================

CREATE OR REPLACE FUNCTION can_synthesize(p_user_id UUID, p_characters INTEGER)
RETURNS TABLE (
    allowed BOOLEAN,
    reason TEXT,
    daily_used INTEGER,
    daily_limit INTEGER,
    monthly_used INTEGER,
    monthly_limit INTEGER
) AS $$
DECLARE
    v_tier subscription_tier;
    v_daily_limit INTEGER;
    v_monthly_limit INTEGER;
    v_daily_used INTEGER;
    v_monthly_used INTEGER;
    v_today DATE := CURRENT_DATE;
    v_month TEXT := TO_CHAR(CURRENT_DATE, 'YYYY-MM');
BEGIN
    -- Get user tier
    SELECT COALESCE(s.plan_id, 'free') INTO v_tier
    FROM app_users u
    LEFT JOIN subscriptions s ON s.user_id = u.id
    WHERE u.id = p_user_id;

    -- If user not found, assume free tier
    IF v_tier IS NULL THEN
        v_tier := 'free';
    END IF;

    -- Set limits based on tier
    CASE v_tier
        WHEN 'free' THEN
            v_daily_limit := 4000;
            v_monthly_limit := 25000;
        WHEN 'basic' THEN
            v_daily_limit := 50000;
            v_monthly_limit := 500000;
        WHEN 'pro' THEN
            v_daily_limit := 200000;
            v_monthly_limit := 2000000;
        WHEN 'unlimited' THEN
            v_daily_limit := 999999999;
            v_monthly_limit := 999999999;
        ELSE
            v_daily_limit := 4000;
            v_monthly_limit := 25000;
    END CASE;

    -- Get current daily usage
    SELECT COALESCE(characters_used, 0) INTO v_daily_used
    FROM daily_quota
    WHERE user_id = p_user_id AND date = v_today;

    IF v_daily_used IS NULL THEN
        v_daily_used := 0;
    END IF;

    -- Get current monthly usage
    SELECT COALESCE(characters_used, 0) INTO v_monthly_used
    FROM monthly_quota
    WHERE user_id = p_user_id AND month = v_month;

    IF v_monthly_used IS NULL THEN
        v_monthly_used := 0;
    END IF;

    -- Check limits
    IF v_daily_used + p_characters > v_daily_limit THEN
        RETURN QUERY SELECT
            FALSE,
            'Daily quota exceeded. You have ' || (v_daily_limit - v_daily_used) || ' characters remaining.',
            v_daily_used,
            v_daily_limit,
            v_monthly_used,
            v_monthly_limit;
        RETURN;
    END IF;

    IF v_monthly_used + p_characters > v_monthly_limit THEN
        RETURN QUERY SELECT
            FALSE,
            'Monthly quota exceeded. You have ' || (v_monthly_limit - v_monthly_used) || ' characters remaining.',
            v_daily_used,
            v_daily_limit,
            v_monthly_used,
            v_monthly_limit;
        RETURN;
    END IF;

    -- Update quotas (upsert)
    INSERT INTO daily_quota (user_id, date, characters_used, request_count)
    VALUES (p_user_id, v_today, p_characters, 1)
    ON CONFLICT (user_id, date)
    DO UPDATE SET
        characters_used = daily_quota.characters_used + p_characters,
        request_count = daily_quota.request_count + 1,
        updated_at = NOW();

    INSERT INTO monthly_quota (user_id, month, characters_used, request_count)
    VALUES (p_user_id, v_month, p_characters, 1)
    ON CONFLICT (user_id, month)
    DO UPDATE SET
        characters_used = monthly_quota.characters_used + p_characters,
        request_count = monthly_quota.request_count + 1,
        updated_at = NOW();

    RETURN QUERY SELECT
        TRUE,
        NULL::TEXT,
        v_daily_used + p_characters,
        v_daily_limit,
        v_monthly_used + p_characters,
        v_monthly_limit;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Seed Default Voices (Kokoro)
-- ============================================================================

INSERT INTO voices (name, description, style, category, provider, provider_voice_id, provider_model_id, language, gender, is_premium, tier_required, sort_order) VALUES
('Adam', 'Professional male narrator voice', 'narrative', 'general', 'selfhosted', 'am_adam', NULL, 'en-US', 'male', false, 'free', 1),
('Nicole', 'Warm and clear female voice', 'conversational', 'general', 'selfhosted', 'af_nicole', NULL, 'en-US', 'female', false, 'free', 2),
('Bella', 'Calm and soothing female voice', 'conversational', 'general', 'selfhosted', 'af_bella', NULL, 'en-US', 'female', false, 'free', 3),
('Michael', 'Storyteller male voice', 'narrative', 'general', 'selfhosted', 'am_michael', NULL, 'en-US', 'male', false, 'free', 4),
('George', 'Deep British male voice', 'narrative', 'general', 'selfhosted', 'bm_george', NULL, 'en-US', 'male', false, 'free', 5),
('Emma', 'Elegant British female voice', 'conversational', 'general', 'selfhosted', 'bf_emma', NULL, 'en-US', 'female', false, 'free', 6);

-- ============================================================================
-- Row Level Security (RLS)
-- ============================================================================

ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_quota ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_quota ENABLE ROW LEVEL SECURITY;

-- Allow service role to bypass RLS (backend uses service_role key)
CREATE POLICY "Service role full access on app_users" ON app_users FOR ALL USING (true);
CREATE POLICY "Service role full access on subscriptions" ON subscriptions FOR ALL USING (true);
CREATE POLICY "Service role full access on tts_usage" ON tts_usage FOR ALL USING (true);
CREATE POLICY "Service role full access on daily_quota" ON daily_quota FOR ALL USING (true);
CREATE POLICY "Service role full access on monthly_quota" ON monthly_quota FOR ALL USING (true);

-- Voices table is public read
CREATE POLICY "Anyone can read active voices" ON voices FOR SELECT USING (is_active = true);

-- Latency tables policies
ALTER TABLE latency_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE latency_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on latency_metrics" ON latency_metrics FOR ALL USING (true);
CREATE POLICY "Service role full access on latency_cache" ON latency_cache FOR ALL USING (true);
CREATE POLICY "Anyone can read latency_cache" ON latency_cache FOR SELECT USING (true);
