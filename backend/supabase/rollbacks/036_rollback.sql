-- backend/supabase/rollbacks/036_rollback.sql
-- Drops the ledger. Rows in subscriptions that the ledger wrote keep their plan_id (revoke by hand if needed first).
ALTER TABLE subscriptions DROP COLUMN IF EXISTS entitlement_managed;
DROP TABLE IF EXISTS stripe_webhook_events;
DROP TABLE IF EXISTS entitlement_sources;
