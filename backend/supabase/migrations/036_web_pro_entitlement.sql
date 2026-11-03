-- backend/supabase/migrations/036_web_pro_entitlement.sql
-- Migration 036: web Pro (Stripe) entitlement ledger + webhook idempotency.
-- MIGRATION-NOT-APPLIED: run by the owner in the Supabase SQL editor BEFORE turning WEB_PRO_ENTITLEMENT_ENABLED on.
-- Rollback: backend/supabase/rollbacks/036_rollback.sql
--
-- getUserTier() reads subscriptions.plan_id. That stays the one table the rest of the backend reads. This migration adds:
--   * entitlement_sources: one row per (user, source) so a Stripe web subscription and a RevenueCat (Android) one can
--     coexist; the effective tier written to subscriptions is the highest active one ("highest wins").
--   * stripe_webhook_events: one row per processed Stripe event id (replay protection).
--   * subscriptions.entitlement_managed: true only for rows this ledger wrote, so a hand-set row (e.g. a comped
--     unlimited user) is never downgraded by a Stripe cancellation.
-- SECURITY: RLS on, one service_role policy, anon/authenticated revoked (same pattern as 033/034/035).

CREATE TABLE IF NOT EXISTS entitlement_sources (
    id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID        NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    source                  TEXT        NOT NULL CHECK (source IN (stripe, revenuecat)),
    tier                    subscription_tier   NOT NULL DEFAULT free,
    status                  subscription_status NOT NULL DEFAULT active,
    stripe_customer_id      TEXT,
    stripe_subscription_id  TEXT,
    current_period_end      TIMESTAMPTZ,
    canceled_at             TIMESTAMPTZ,
    last_event_created      BIGINT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, source)
);
CREATE INDEX IF NOT EXISTS idx_entitlement_sources_stripe_sub ON entitlement_sources(stripe_subscription_id)
    WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id     TEXT        PRIMARY KEY,
    type         TEXT        NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS entitlement_managed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE entitlement_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on entitlement_sources" ON entitlement_sources;
CREATE POLICY "Service role only on entitlement_sources" ON entitlement_sources
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON entitlement_sources FROM anon, authenticated;

ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on stripe_webhook_events" ON stripe_webhook_events;
CREATE POLICY "Service role only on stripe_webhook_events" ON stripe_webhook_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON stripe_webhook_events FROM anon, authenticated;
