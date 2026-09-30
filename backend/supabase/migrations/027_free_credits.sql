-- ============================================================================
-- Migration: Free credits (per USER, one-time grant)
--
-- Users without an active payment method get a small pool of free credits that
-- is usable across the metered developer-API features (dub, speech-to-text,
-- voice isolation, voice conversion, sound effects, voice design). The unit is
-- the existing meter unit ("character-equivalent", 1 unit = $0.00001), so the
-- default grant of 10,000 units = $0.10 = the "10,000 characters" advertised.
-- The grant amount lives in the backend (FREE_CREDIT_UNITS in
-- src/lib/realtimeTtsBilling.ts) and is passed to consume_free_credits();
-- the DEFAULT below is only a fallback.
-- NOT applied automatically -- run it before deploying the backend that uses it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS realtimetts_free_credits (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    granted BIGINT NOT NULL CHECK (granted >= 0),
    used BIGINT NOT NULL DEFAULT 0 CHECK (used >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE realtimetts_free_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on realtimetts_free_credits" ON realtimetts_free_credits;

CREATE POLICY "Service role full access on realtimetts_free_credits" ON realtimetts_free_credits
    FOR ALL
    USING (true);

-- Idempotency ledger: one row per deduction that carried an identifier (a job id), so a
-- re-polled finished job is never charged against the credits twice.
CREATE TABLE IF NOT EXISTS realtimetts_free_credit_events (
    identifier TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    units BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE realtimetts_free_credit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on realtimetts_free_credit_events" ON realtimetts_free_credit_events;

CREATE POLICY "Service role full access on realtimetts_free_credit_events" ON realtimetts_free_credit_events
    FOR ALL
    USING (true);

-- Atomically consumes up to p_units and returns the units ACTUALLY consumed
-- (never more than what remains, so no negative balance). Creates the user's row
-- with p_grant on first use. The row is locked (FOR UPDATE) for the read-then-update,
-- so concurrent calls serialize and can never over-consume.
-- p_identifier (optional): repeat calls with the same identifier consume 0.
CREATE OR REPLACE FUNCTION consume_free_credits(
    p_user UUID,
    p_units BIGINT,
    p_grant BIGINT DEFAULT 10000,
    p_identifier TEXT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_remaining BIGINT;
    v_consumed BIGINT;
    v_inserted INT;
BEGIN
    IF p_units IS NULL OR p_units <= 0 THEN
        RETURN 0;
    END IF;

    IF p_identifier IS NOT NULL THEN
        INSERT INTO realtimetts_free_credit_events (identifier, user_id, units)
        VALUES (p_identifier, p_user, 0)
        ON CONFLICT (identifier) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted = 0 THEN
            RETURN 0; -- already charged for this job
        END IF;
    END IF;

    INSERT INTO realtimetts_free_credits (user_id, granted)
    VALUES (p_user, GREATEST(p_grant, 0))
    ON CONFLICT (user_id) DO NOTHING;

    SELECT GREATEST(granted - used, 0) INTO v_remaining
    FROM realtimetts_free_credits
    WHERE user_id = p_user
    FOR UPDATE;

    v_consumed := LEAST(p_units, v_remaining);

    UPDATE realtimetts_free_credits
    SET used = used + v_consumed, updated_at = NOW()
    WHERE user_id = p_user;

    IF p_identifier IS NOT NULL THEN
        UPDATE realtimetts_free_credit_events SET units = v_consumed WHERE identifier = p_identifier;
    END IF;

    RETURN v_consumed;
END;
$$;

-- Only the backend (service role) may call it: it takes an arbitrary user id.
REVOKE ALL ON FUNCTION consume_free_credits(UUID, BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION consume_free_credits(UUID, BIGINT, BIGINT, TEXT) TO service_role;

COMMENT ON TABLE realtimetts_free_credits IS
    'One-time per-user free credit pool (meter units, 1 unit = $0.00001). Consumed via consume_free_credits().';
