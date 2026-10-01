-- ============================================================================
-- Migration: retire the per-feature deployment tables
--
-- DEFERRED: deliberately NOT in supabase/migrations, so a tool that auto-applies that folder (supabase db push)
-- cannot run it early. Apply by hand ONLY AFTER the backend release that reads modal_deployments (030) is live and
-- healthy. Until then the old code still reads these tables, and dropping them would break it.
--
-- voice convert and isolate now use modal_deployments through lib/modalDeployments.ts. The only rows in
-- these tables belonged to the owner's own testing and pointed at Modal apps stopped on 2026-09-30, so
-- nothing is migrated. A user who deployed under the old code simply deploys again.
-- ============================================================================

DROP TABLE IF EXISTS user_voice_convert_deployments;
DROP TABLE IF EXISTS user_voice_isolate_deployments;
