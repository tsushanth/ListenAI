-- ============================================================================
-- Migration: one table for every self-serve Modal deployment
--
-- Replaces the per-feature user_voice_convert_deployments / user_voice_isolate_deployments tables
-- (dropped in a later migration, after the release that stops reading them). Every feature
-- (convert, isolate, sound_effect, music, dub) uses the same lifecycle:
--   requested -> deploying -> ready -> stopping -> stopped      (failed is reachable from requested/deploying)
-- The backend deploys the user's own Modal app, routes that user's jobs to it, and tears it down on
-- request, after an idle timeout, or at a maximum age. See lib/modalDeployments.ts.
--
-- The row holds the per-deployment bearer secret the backend uses to call the app, so the table is
-- locked to the service role exactly like 029 does for the billing tables. The API never returns it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS modal_deployments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service            TEXT NOT NULL CHECK (service IN ('convert', 'isolate', 'sound_effect', 'music', 'dub')),
  app_name           TEXT NOT NULL,
  modal_url          TEXT NOT NULL,
  secret_name        TEXT NOT NULL,
  modal_secret       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'requested'
                       CHECK (status IN ('requested', 'deploying', 'ready', 'stopping', 'stopped', 'failed')),
  error              TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,       -- teardown attempts, so a stuck stop is retried then reported
  job_count          INTEGER NOT NULL DEFAULT 0,
  gpu_seconds        NUMERIC NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deploy_started_at  TIMESTAMPTZ,
  ready_at           TIMESTAMPTZ,
  last_used_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,                      -- hard maximum age, regardless of use
  stopping_at        TIMESTAMPTZ,
  stopped_at         TIMESTAMPTZ,
  stop_reason        TEXT,                             -- user | idle | max_age | deploy_failed | deploy_timeout | orphan | spend_cap | ...
  volume_names       TEXT[] NOT NULL DEFAULT '{}',     -- per-user Modal Volumes to delete after retention
  volume_delete_at   TIMESTAMPTZ,
  volumes_deleted_at TIMESTAMPTZ
);

-- At most one live deployment per user per service. 'failed' and 'stopped' rows are history and do not block a redeploy.
CREATE UNIQUE INDEX IF NOT EXISTS modal_deployments_one_live
  ON modal_deployments (user_id, service)
  WHERE status IN ('requested', 'deploying', 'ready', 'stopping');

CREATE INDEX IF NOT EXISTS modal_deployments_status_idx ON modal_deployments (status, last_used_at);
CREATE INDEX IF NOT EXISTS modal_deployments_user_created_idx ON modal_deployments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS modal_deployments_volume_cleanup_idx
  ON modal_deployments (volume_delete_at) WHERE volumes_deleted_at IS NULL AND volume_delete_at IS NOT NULL;

ALTER TABLE modal_deployments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on modal_deployments" ON modal_deployments;
CREATE POLICY "Service role full access on modal_deployments" ON modal_deployments
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON modal_deployments FROM anon, authenticated;
