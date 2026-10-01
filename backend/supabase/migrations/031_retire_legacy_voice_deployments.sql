-- ============================================================================
-- Migration: retire the per-feature deployment tables
--
-- APPLY ONLY AFTER the backend release that reads modal_deployments (030) is live. Until then the old
-- code still reads these tables.
--
-- voice convert and isolate now use modal_deployments through lib/modalDeployments.ts. The only rows in
-- these tables belonged to the owner's own testing and pointed at Modal apps stopped on 2026-09-30, so
-- nothing is migrated. A user who deployed under the old code simply deploys again.
-- ============================================================================

DROP TABLE IF EXISTS user_voice_convert_deployments;
DROP TABLE IF EXISTS user_voice_isolate_deployments;
