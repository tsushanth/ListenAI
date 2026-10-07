-- ============================================================================
-- Migration 034: RevenueCat entitlements (Android/iOS subscribers -> backend 'paid' plan)
--
-- DRAFT. NOT APPLIED to any Supabase project. The owner reviews and applies it.
--
-- Why a NEW table instead of reusing `subscriptions`:
--   POST /api/subscription/sync (routes/subscription.ts) lets ANY authenticated user write their own
--   `subscriptions` row from client-supplied product_id / expires_date with no store verification. If the voice
--   cloning payment gate trusted `subscriptions`, anyone could self-grant 'paid'. These tables are written ONLY by
--   the RevenueCat webhook (authenticated by a shared secret) through the service role.
--
-- SECURITY: ReadAloud has an open RLS problem on older tables. Nothing here widens it: RLS enabled, single policy
-- TO service_role, all anon/authenticated privileges revoked. Do not add permissive policies.
--
--   revenuecat_webhook_events  one row per processed RevenueCat event id (idempotency)
--   revenuecat_entitlements    one row per user: current plan/status/expiry + last_event_ts_ms for ordering
--   apply_revenuecat_event()   atomic: dedupe by event id, then upsert only if the event is not older than the row
--
-- user_id is not an FK (matches 033): no dependency on app_users being populated.
-- Rollback: backend/supabase/rollbacks/034_rollback.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS revenuecat_webhook_events (
    event_id      TEXT PRIMARY KEY,
    event_type    TEXT NOT NULL,
    user_id       UUID,
    event_ts_ms   BIGINT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revenuecat_entitlements (
    user_id         UUID PRIMARY KEY,
    plan_id         TEXT NOT NULL DEFAULT 'basic' CHECK (plan_id IN ('free', 'basic', 'pro', 'unlimited')),
    status          TEXT NOT NULL CHECK (status IN ('active', 'expired')),
    product_id      TEXT,
    store           TEXT,
    expires_at      TIMESTAMPTZ,
    canceled_at     TIMESTAMPTZ,
    cancel_reason   TEXT,
    last_event_id   TEXT,
    last_event_type TEXT,
    last_event_ts_ms BIGINT NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenuecat_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role only" ON revenuecat_webhook_events;
CREATE POLICY "service role only" ON revenuecat_webhook_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "service role only" ON revenuecat_entitlements;
CREATE POLICY "service role only" ON revenuecat_entitlements
    FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON revenuecat_webhook_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON revenuecat_entitlements FROM PUBLIC, anon, authenticated;

-- Returns 'duplicate' (event id already processed), 'stale' (older than the stored state; event recorded, row
-- untouched) or 'applied'. One statement block = one transaction, so a crash cannot record an event without applying it.
CREATE OR REPLACE FUNCTION apply_revenuecat_event(
    p_event_id TEXT, p_event_type TEXT, p_user_id UUID, p_event_ts_ms BIGINT,
    p_status TEXT, p_plan_id TEXT, p_product_id TEXT, p_store TEXT,
    p_expires_at TIMESTAMPTZ, p_canceled_at TIMESTAMPTZ, p_cancel_reason TEXT
) RETURNS TEXT LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE n INTEGER;
BEGIN
    INSERT INTO revenuecat_webhook_events (event_id, event_type, user_id, event_ts_ms)
    VALUES (p_event_id, p_event_type, p_user_id, p_event_ts_ms)
    ON CONFLICT (event_id) DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RETURN 'duplicate'; END IF;

    INSERT INTO revenuecat_entitlements AS e (
        user_id, plan_id, status, product_id, store, expires_at, canceled_at, cancel_reason,
        last_event_id, last_event_type, last_event_ts_ms, updated_at)
    VALUES (
        p_user_id, p_plan_id, p_status, p_product_id, p_store, p_expires_at, p_canceled_at, p_cancel_reason,
        p_event_id, p_event_type, p_event_ts_ms, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
        plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, product_id = EXCLUDED.product_id,
        store = EXCLUDED.store, expires_at = EXCLUDED.expires_at, canceled_at = EXCLUDED.canceled_at,
        cancel_reason = EXCLUDED.cancel_reason, last_event_id = EXCLUDED.last_event_id,
        last_event_type = EXCLUDED.last_event_type, last_event_ts_ms = EXCLUDED.last_event_ts_ms,
        updated_at = NOW()
    WHERE e.last_event_ts_ms <= EXCLUDED.last_event_ts_ms;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN CASE WHEN n = 0 THEN 'stale' ELSE 'applied' END;
END;
$$;
REVOKE ALL ON FUNCTION apply_revenuecat_event(TEXT, TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_revenuecat_event(TEXT, TEXT, UUID, BIGINT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role;

COMMIT;
