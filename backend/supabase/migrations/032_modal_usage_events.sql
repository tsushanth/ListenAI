-- ============================================================================
-- Migration: measured Modal usage per job (shadow mode)
--
-- Each worker reports the GPU seconds it spent on a request (gpu_seconds in the job status for convert/isolate,
-- the X-GPU-Seconds header for sound effects). This table records them per job so usage can be compared with
-- Modal's own bill before anyone is charged on the new basis. Recording only: nothing here bills a user.
--
-- record_modal_usage() inserts the event and adds to the deployment's running total in one step, and is
-- idempotent per (service, job_id), so a client that re-polls a finished job cannot count it twice.
-- ============================================================================

CREATE TABLE IF NOT EXISTS modal_usage_events (
  id             BIGSERIAL PRIMARY KEY,
  deployment_id  UUID REFERENCES modal_deployments(id) ON DELETE SET NULL,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service        TEXT NOT NULL CHECK (service IN ('convert', 'isolate', 'sound_effect', 'music', 'dub')),
  job_id         TEXT NOT NULL,
  gpu_seconds    NUMERIC NOT NULL CHECK (gpu_seconds >= 0),
  recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service, job_id)
);

CREATE INDEX IF NOT EXISTS modal_usage_events_deployment_idx ON modal_usage_events (deployment_id);
CREATE INDEX IF NOT EXISTS modal_usage_events_user_time_idx ON modal_usage_events (user_id, recorded_at DESC);

ALTER TABLE modal_usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on modal_usage_events" ON modal_usage_events;
CREATE POLICY "Service role full access on modal_usage_events" ON modal_usage_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON modal_usage_events FROM anon, authenticated;
GRANT ALL ON modal_usage_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE modal_usage_events_id_seq TO service_role;

-- Returns true when the event was newly recorded, false when this (service, job_id) was already recorded.
CREATE OR REPLACE FUNCTION public.record_modal_usage(
  p_deployment_id UUID,
  p_user_id       UUID,
  p_service       TEXT,
  p_job_id        TEXT,
  p_gpu_seconds   NUMERIC
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted INTEGER;
BEGIN
  INSERT INTO modal_usage_events (deployment_id, user_id, service, job_id, gpu_seconds)
  VALUES (p_deployment_id, p_user_id, p_service, p_job_id, p_gpu_seconds)
  ON CONFLICT (service, job_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF inserted = 1 AND p_deployment_id IS NOT NULL THEN
    UPDATE modal_deployments
       SET gpu_seconds = gpu_seconds + p_gpu_seconds, updated_at = now()
     WHERE id = p_deployment_id;
  END IF;
  RETURN inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.record_modal_usage(UUID, UUID, TEXT, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_modal_usage(UUID, UUID, TEXT, TEXT, NUMERIC) TO service_role;
