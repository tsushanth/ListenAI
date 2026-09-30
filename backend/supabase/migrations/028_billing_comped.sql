-- ============================================================================
-- Migration: Comped (complimentary) billing accounts
--
-- A comped row (active = true, comped = true) grants full access -- every
-- feature including voice cloning and music, gateway keys billing-enabled --
-- with NO Stripe objects: usage is never reported to Stripe, nothing is charged,
-- no free credits are deducted, and Stripe webhook events never modify it.
-- So the three Stripe id columns become NULLable (a comped row has none).
-- NOT applied automatically -- run it before deploying the backend that uses it.
--
-- To comp a user (service role / SQL editor):
--   INSERT INTO realtimetts_billing (user_id, active, comped)
--   VALUES ('<auth.users.id>', true, true)
--   ON CONFLICT (user_id) DO UPDATE SET active = true, comped = true, updated_at = NOW();
-- To un-comp: UPDATE realtimetts_billing SET comped = false, active = false WHERE user_id = '<id>';
-- ============================================================================

ALTER TABLE realtimetts_billing
    ADD COLUMN IF NOT EXISTS comped BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE realtimetts_billing ALTER COLUMN stripe_customer_id DROP NOT NULL;
ALTER TABLE realtimetts_billing ALTER COLUMN stripe_subscription_id DROP NOT NULL;
ALTER TABLE realtimetts_billing ALTER COLUMN stripe_subscription_item_id DROP NOT NULL;

-- A non-comped row must still carry its Stripe ids.
ALTER TABLE realtimetts_billing DROP CONSTRAINT IF EXISTS realtimetts_billing_stripe_ids_unless_comped;
ALTER TABLE realtimetts_billing ADD CONSTRAINT realtimetts_billing_stripe_ids_unless_comped
    CHECK (comped OR (stripe_customer_id IS NOT NULL AND stripe_subscription_id IS NOT NULL AND stripe_subscription_item_id IS NOT NULL));
