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
  -- SET NULL, not CASCADE: deleting an account must not erase the record of an app that may still be running on our
  -- Modal bill. The reaper and the orphan sweep keep working on rows with no user.
  user_id            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
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
GRANT ALL ON modal_deployments TO service_role;

-- ============================================================================
-- Atomic claim: check the caps and insert in one step.
--
-- Counting rows and then inserting leaves a window in which many concurrent requests all pass the count and all insert,
-- overshooting the per-user and global caps. This function takes a transaction-scoped advisory lock first, so claims are
-- serialised: every claim sees every earlier claim. Checks run in this order and the first failure wins:
--   conflict   the user already has a live deployment of this service (also enforced by the unique index above)
--   user_cap   the user already has p_max_user live deployments
--   global_cap there are already p_max_global live deployments
--   daily_cap  the user created p_max_daily deployments since p_daily_since
-- Returns jsonb: {result:'inserted', row:{...}} | {result:'conflict'} | {result:'denied', code:'...'}
-- ============================================================================
CREATE OR REPLACE FUNCTION public.claim_modal_deployment(
  p_user_id      UUID,
  p_service      TEXT,
  p_app_name     TEXT,
  p_modal_url    TEXT,
  p_secret_name  TEXT,
  p_modal_secret TEXT,
  p_volume_names TEXT[],
  p_max_user     INTEGER,
  p_max_global   INTEGER,
  p_max_daily    INTEGER,
  p_daily_since  TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  live_user    INTEGER;
  live_global  INTEGER;
  created_days INTEGER;
  new_row      modal_deployments;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('modal_deployments_claim'));

  IF EXISTS (
    SELECT 1 FROM modal_deployments
     WHERE user_id = p_user_id AND service = p_service
       AND status IN ('requested', 'deploying', 'ready', 'stopping')
  ) THEN
    RETURN jsonb_build_object('result', 'conflict');
  END IF;

  SELECT count(*) INTO live_user FROM modal_deployments
   WHERE user_id = p_user_id AND status IN ('requested', 'deploying', 'ready', 'stopping');
  IF live_user >= p_max_user THEN
    RETURN jsonb_build_object('result', 'denied', 'code', 'user_cap');
  END IF;

  SELECT count(*) INTO live_global FROM modal_deployments
   WHERE status IN ('requested', 'deploying', 'ready', 'stopping');
  IF live_global >= p_max_global THEN
    RETURN jsonb_build_object('result', 'denied', 'code', 'global_cap');
  END IF;

  SELECT count(*) INTO created_days FROM modal_deployments
   WHERE user_id = p_user_id AND created_at >= p_daily_since;
  IF created_days >= p_max_daily THEN
    RETURN jsonb_build_object('result', 'denied', 'code', 'daily_cap');
  END IF;

  INSERT INTO modal_deployments (user_id, service, app_name, modal_url, secret_name, modal_secret, volume_names)
  VALUES (p_user_id, p_service, p_app_name, p_modal_url, p_secret_name, p_modal_secret, COALESCE(p_volume_names, '{}'))
  RETURNING * INTO new_row;

  RETURN jsonb_build_object('result', 'inserted', 'row', to_jsonb(new_row));
END;
$$;

REVOKE ALL ON FUNCTION public.claim_modal_deployment(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_modal_deployment(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], INTEGER, INTEGER, INTEGER, TIMESTAMPTZ) TO service_role;
