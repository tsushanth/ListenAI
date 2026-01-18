-- ============================================================================
-- Migration: Add Latency Tracking Tables
-- Run this to add latency tracking to an existing database
-- ============================================================================

-- Latency Metrics Table
-- Stores individual latency measurements from iOS clients
CREATE TABLE IF NOT EXISTS latency_metrics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID,  -- Nullable for anonymous tracking
    text_length INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    provider tts_provider DEFAULT 'selfhosted',
    voice_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Latency Cache Table
-- Stores aggregated latency statistics by text length bucket
CREATE TABLE IF NOT EXISTS latency_cache (
    bucket_id TEXT PRIMARY KEY,  -- e.g., '0-500', '501-1000'
    min_length INTEGER NOT NULL,
    max_length INTEGER NOT NULL,
    avg_latency_ms INTEGER NOT NULL,
    p50_latency_ms INTEGER NOT NULL,
    p95_latency_ms INTEGER NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_latency_metrics_text_length ON latency_metrics(text_length);
CREATE INDEX IF NOT EXISTS idx_latency_metrics_created_at ON latency_metrics(created_at);

-- Row Level Security
ALTER TABLE latency_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE latency_cache ENABLE ROW LEVEL SECURITY;

-- Policies (drop first if exist)
DROP POLICY IF EXISTS "Service role full access on latency_metrics" ON latency_metrics;
DROP POLICY IF EXISTS "Service role full access on latency_cache" ON latency_cache;
DROP POLICY IF EXISTS "Anyone can read latency_cache" ON latency_cache;

CREATE POLICY "Service role full access on latency_metrics" ON latency_metrics FOR ALL USING (true);
CREATE POLICY "Service role full access on latency_cache" ON latency_cache FOR ALL USING (true);
CREATE POLICY "Anyone can read latency_cache" ON latency_cache FOR SELECT USING (true);

-- Seed default cache values (optional - will be overwritten by real data)
INSERT INTO latency_cache (bucket_id, min_length, max_length, avg_latency_ms, p50_latency_ms, p95_latency_ms, sample_count)
VALUES
    ('0-500', 0, 500, 2000, 2000, 3000, 0),
    ('501-1000', 501, 1000, 3500, 3500, 5000, 0),
    ('1001-2500', 1001, 2500, 6000, 6000, 9000, 0),
    ('2501-5000', 2501, 5000, 10000, 10000, 15000, 0),
    ('5001-10000', 5001, 10000, 18000, 18000, 25000, 0),
    ('10001+', 10001, 999999999, 30000, 30000, 45000, 0)
ON CONFLICT (bucket_id) DO NOTHING;
