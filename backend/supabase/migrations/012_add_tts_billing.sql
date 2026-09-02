-- ============================================================================
-- Migration: TTS Realtime API Billing
-- One row per Supabase user who has attached a payment method for the
-- realtime-tts API. Billing is per-user (one Stripe Customer/Subscription),
-- not per-key -- a user's gateway keys are all gated on this row existing and
-- being active (see gateway/keys.js billingEnabled, set via the backend after
-- checkout completes).
-- ============================================================================

CREATE TABLE IF NOT EXISTS realtimetts_billing (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

    stripe_customer_id TEXT NOT NULL,
    stripe_subscription_id TEXT NOT NULL,
    stripe_subscription_item_id TEXT NOT NULL, -- what usage records get reported against

    -- Mirrors the gateway's billingEnabled flag on this user's keys. Kept here too
    -- so the ReadAloud web UI can show billing status without calling the gateway.
    active BOOLEAN NOT NULL DEFAULT true,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_realtimetts_billing_user_id ON realtimetts_billing(user_id);
CREATE INDEX IF NOT EXISTS idx_realtimetts_billing_stripe_customer_id ON realtimetts_billing(stripe_customer_id);

ALTER TABLE realtimetts_billing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on realtimetts_billing" ON realtimetts_billing
    FOR ALL
    USING (true);

COMMENT ON TABLE realtimetts_billing IS
    'Per-user Stripe metered billing state for the realtime-tts API. Existence of an
     active row is what gates a user''s gateway API keys from billingEnabled=false to
     true (see gateway/keys.js and src/lib/ttsGatewayClient.ts setGatewayKeyBilling).';
