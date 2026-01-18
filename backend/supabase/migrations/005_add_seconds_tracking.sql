-- Migration: Add seconds-based usage tracking for quotas
-- This adds audio_seconds tracking alongside character tracking

-- ============================================================================
-- Add seconds columns to daily_quota
-- ============================================================================

ALTER TABLE daily_quota
  ADD COLUMN IF NOT EXISTS seconds_used INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seconds_limit INTEGER DEFAULT 300;  -- 5 min default (free tier)

-- ============================================================================
-- Add seconds columns to monthly_quota
-- ============================================================================

ALTER TABLE monthly_quota
  ADD COLUMN IF NOT EXISTS seconds_used INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS seconds_limit INTEGER DEFAULT 1800;  -- 30 min default (free tier)

-- ============================================================================
-- Add audio_duration_sec to tts_jobs for accurate tracking
-- ============================================================================

-- Already exists as duration_sec, but ensure it's populated

-- ============================================================================
-- Add priority column to tts_jobs for tier-based queue ordering
-- ============================================================================

ALTER TABLE tts_jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;

-- Create index for priority-based queue ordering
CREATE INDEX IF NOT EXISTS idx_tts_jobs_priority_created
  ON tts_jobs (priority DESC, created_at ASC)
  WHERE status = 'queued';

-- ============================================================================
-- Update can_synthesize function to check seconds limits
-- ============================================================================

CREATE OR REPLACE FUNCTION can_synthesize_v2(
  p_user_id UUID,
  p_characters INTEGER,
  p_estimated_seconds INTEGER DEFAULT NULL
)
RETURNS TABLE (
  allowed BOOLEAN,
  reason TEXT,
  daily_seconds_used INTEGER,
  daily_seconds_limit INTEGER,
  monthly_seconds_used INTEGER,
  monthly_seconds_limit INTEGER,
  daily_chars_used INTEGER,
  daily_chars_limit INTEGER,
  monthly_chars_used INTEGER,
  monthly_chars_limit INTEGER,
  priority INTEGER
) AS $$
DECLARE
  v_tier TEXT;
  v_daily_seconds_limit INTEGER;
  v_monthly_seconds_limit INTEGER;
  v_daily_chars_limit INTEGER;
  v_monthly_chars_limit INTEGER;
  v_priority INTEGER;
  v_today DATE;
  v_month TEXT;
  v_daily_seconds INTEGER;
  v_monthly_seconds INTEGER;
  v_daily_chars INTEGER;
  v_monthly_chars INTEGER;
  v_estimated_sec INTEGER;
BEGIN
  -- Get current date/month
  v_today := CURRENT_DATE;
  v_month := TO_CHAR(CURRENT_DATE, 'YYYY-MM');

  -- Get user's subscription tier (default to 'free')
  SELECT COALESCE(s.plan_id, 'free')::TEXT INTO v_tier
  FROM subscriptions s
  WHERE s.user_id = p_user_id
    AND s.status IN ('active', 'trialing')
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF v_tier IS NULL THEN
    v_tier := 'free';
  END IF;

  -- Set limits based on tier
  CASE v_tier
    WHEN 'free' THEN
      v_daily_seconds_limit := 300;      -- 5 minutes
      v_monthly_seconds_limit := 1800;   -- 30 minutes
      v_daily_chars_limit := 4000;
      v_monthly_chars_limit := 25000;
      v_priority := 0;
    WHEN 'basic' THEN
      v_daily_seconds_limit := 1800;     -- 30 minutes
      v_monthly_seconds_limit := 18000;  -- 5 hours
      v_daily_chars_limit := 25000;
      v_monthly_chars_limit := 250000;
      v_priority := 1;
    WHEN 'pro' THEN
      v_daily_seconds_limit := 7200;     -- 2 hours
      v_monthly_seconds_limit := 72000;  -- 20 hours
      v_daily_chars_limit := 100000;
      v_monthly_chars_limit := 1000000;
      v_priority := 2;
    WHEN 'unlimited' THEN
      v_daily_seconds_limit := 999999;
      v_monthly_seconds_limit := 999999;
      v_daily_chars_limit := 999999999;
      v_monthly_chars_limit := 999999999;
      v_priority := 3;
    ELSE
      v_daily_seconds_limit := 300;
      v_monthly_seconds_limit := 1800;
      v_daily_chars_limit := 4000;
      v_monthly_chars_limit := 25000;
      v_priority := 0;
  END CASE;

  -- Get current daily usage
  SELECT COALESCE(dq.seconds_used, 0), COALESCE(dq.characters_used, 0)
  INTO v_daily_seconds, v_daily_chars
  FROM daily_quota dq
  WHERE dq.user_id = p_user_id AND dq.date = v_today;

  IF NOT FOUND THEN
    v_daily_seconds := 0;
    v_daily_chars := 0;
  END IF;

  -- Get current monthly usage
  SELECT COALESCE(mq.seconds_used, 0), COALESCE(mq.characters_used, 0)
  INTO v_monthly_seconds, v_monthly_chars
  FROM monthly_quota mq
  WHERE mq.user_id = p_user_id AND mq.month = v_month;

  IF NOT FOUND THEN
    v_monthly_seconds := 0;
    v_monthly_chars := 0;
  END IF;

  -- Estimate seconds if not provided (12.5 chars per second)
  IF p_estimated_seconds IS NULL THEN
    v_estimated_sec := CEIL(p_characters / 12.5);
  ELSE
    v_estimated_sec := p_estimated_seconds;
  END IF;

  -- Check daily seconds limit
  IF v_daily_seconds + v_estimated_sec > v_daily_seconds_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'Daily audio limit exceeded. You have ' || (v_daily_seconds_limit - v_daily_seconds) || ' seconds remaining today.',
      v_daily_seconds, v_daily_seconds_limit,
      v_monthly_seconds, v_monthly_seconds_limit,
      v_daily_chars, v_daily_chars_limit,
      v_monthly_chars, v_monthly_chars_limit,
      v_priority;
    RETURN;
  END IF;

  -- Check monthly seconds limit
  IF v_monthly_seconds + v_estimated_sec > v_monthly_seconds_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'Monthly audio limit exceeded. You have ' || (v_monthly_seconds_limit - v_monthly_seconds) || ' seconds remaining this month.',
      v_daily_seconds, v_daily_seconds_limit,
      v_monthly_seconds, v_monthly_seconds_limit,
      v_daily_chars, v_daily_chars_limit,
      v_monthly_chars, v_monthly_chars_limit,
      v_priority;
    RETURN;
  END IF;

  -- Check daily character limit (backward compatibility)
  IF v_daily_chars + p_characters > v_daily_chars_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'Daily character limit exceeded. You have ' || (v_daily_chars_limit - v_daily_chars) || ' characters remaining today.',
      v_daily_seconds, v_daily_seconds_limit,
      v_monthly_seconds, v_monthly_seconds_limit,
      v_daily_chars, v_daily_chars_limit,
      v_monthly_chars, v_monthly_chars_limit,
      v_priority;
    RETURN;
  END IF;

  -- Check monthly character limit (backward compatibility)
  IF v_monthly_chars + p_characters > v_monthly_chars_limit THEN
    RETURN QUERY SELECT
      FALSE,
      'Monthly character limit exceeded. You have ' || (v_monthly_chars_limit - v_monthly_chars) || ' characters remaining this month.',
      v_daily_seconds, v_daily_seconds_limit,
      v_monthly_seconds, v_monthly_seconds_limit,
      v_daily_chars, v_daily_chars_limit,
      v_monthly_chars, v_monthly_chars_limit,
      v_priority;
    RETURN;
  END IF;

  -- All checks passed - atomically update quotas
  -- Daily quota upsert
  INSERT INTO daily_quota (user_id, date, characters_used, seconds_used, seconds_limit, request_count, created_at, updated_at)
  VALUES (p_user_id, v_today, p_characters, v_estimated_sec, v_daily_seconds_limit, 1, NOW(), NOW())
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    characters_used = daily_quota.characters_used + EXCLUDED.characters_used,
    seconds_used = daily_quota.seconds_used + EXCLUDED.seconds_used,
    seconds_limit = EXCLUDED.seconds_limit,
    request_count = daily_quota.request_count + 1,
    updated_at = NOW();

  -- Monthly quota upsert
  INSERT INTO monthly_quota (user_id, month, characters_used, seconds_used, seconds_limit, request_count, created_at, updated_at)
  VALUES (p_user_id, v_month, p_characters, v_estimated_sec, v_monthly_seconds_limit, 1, NOW(), NOW())
  ON CONFLICT (user_id, month)
  DO UPDATE SET
    characters_used = monthly_quota.characters_used + EXCLUDED.characters_used,
    seconds_used = monthly_quota.seconds_used + EXCLUDED.seconds_used,
    seconds_limit = EXCLUDED.seconds_limit,
    request_count = monthly_quota.request_count + 1,
    updated_at = NOW();

  -- Return success with updated usage
  RETURN QUERY SELECT
    TRUE,
    NULL::TEXT,
    v_daily_seconds + v_estimated_sec,
    v_daily_seconds_limit,
    v_monthly_seconds + v_estimated_sec,
    v_monthly_seconds_limit,
    v_daily_chars + p_characters,
    v_daily_chars_limit,
    v_monthly_chars + p_characters,
    v_monthly_chars_limit,
    v_priority;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Function to update actual audio duration after synthesis
-- ============================================================================

CREATE OR REPLACE FUNCTION update_usage_actual_seconds(
  p_user_id UUID,
  p_estimated_seconds INTEGER,
  p_actual_seconds INTEGER
)
RETURNS VOID AS $$
DECLARE
  v_diff INTEGER;
  v_today DATE;
  v_month TEXT;
BEGIN
  v_diff := p_actual_seconds - p_estimated_seconds;
  v_today := CURRENT_DATE;
  v_month := TO_CHAR(CURRENT_DATE, 'YYYY-MM');

  -- Only update if there's a difference
  IF v_diff != 0 THEN
    UPDATE daily_quota
    SET seconds_used = seconds_used + v_diff,
        updated_at = NOW()
    WHERE user_id = p_user_id AND date = v_today;

    UPDATE monthly_quota
    SET seconds_used = seconds_used + v_diff,
        updated_at = NOW()
    WHERE user_id = p_user_id AND month = v_month;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON FUNCTION can_synthesize_v2 IS
  'Check if user can synthesize audio based on tier limits (seconds + characters).
   Atomically updates quotas if allowed. Returns priority for queue ordering.';

COMMENT ON FUNCTION update_usage_actual_seconds IS
  'Adjust usage tracking after actual audio duration is known (if different from estimate).';
