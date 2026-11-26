-- backend/supabase/migrations/037_listen_usage_and_first_call.sql
-- Migration 037: daily Android listening counts (lib/listenUsage.ts) and the developers page's "run it now" step
-- (lib/firstApiCall.ts). Additive. Apply before deploying the backend that writes them.
-- Rollback: supabase/rollbacks/037_rollback.sql
-- SECURITY: server only. RLS on with a service_role policy, anon/authenticated revoked (same pattern as 035).
BEGIN;

CREATE TABLE IF NOT EXISTS public.listen_daily (
    day      DATE    NOT NULL,
    bucket   TEXT    NOT NULL CHECK (char_length(bucket) <= 40),  -- hashed install ('id:...'), 'anon', 'overflow' or '-'
    ok       INTEGER NOT NULL DEFAULT 0,
    refused  INTEGER NOT NULL DEFAULT 0,
    failed   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, bucket)
);
ALTER TABLE public.listen_daily ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on listen_daily" ON public.listen_daily;
CREATE POLICY "Service role only on listen_daily" ON public.listen_daily FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.listen_daily FROM PUBLIC, anon, authenticated;

-- Adds counts (several machines and restarts add to the same day). Rows older than 180 days are dropped on the way.
CREATE OR REPLACE FUNCTION public.listen_daily_add(p_rows JSONB) RETURNS VOID
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$
  INSERT INTO public.listen_daily AS d (day, bucket, ok, refused, failed)
  SELECT r.day, r.bucket, sum(r.ok), sum(r.refused), sum(r.failed)
  FROM jsonb_to_recordset(p_rows) AS r(day DATE, bucket TEXT, ok INTEGER, refused INTEGER, failed INTEGER)
  GROUP BY r.day, r.bucket
  ON CONFLICT (day, bucket) DO UPDATE SET ok = d.ok + excluded.ok, refused = d.refused + excluded.refused, failed = d.failed + excluded.failed;
  DELETE FROM public.listen_daily WHERE day < (now() AT TIME ZONE 'utc')::date - 180;
$$;

CREATE OR REPLACE FUNCTION public.listen_daily_totals(p_day DATE)
RETURNS TABLE (ok BIGINT, installs BIGINT, no_install_id BIGINT, refused BIGINT, failed BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(sum(d.ok), 0),
         count(*) FILTER (WHERE d.bucket LIKE 'id:%' AND d.ok > 0),
         coalesce(sum(d.ok) FILTER (WHERE d.bucket = 'anon'), 0),
         coalesce(sum(d.refused), 0),
         coalesce(sum(d.failed), 0)
  FROM public.listen_daily d WHERE d.day = p_day;
$$;
REVOKE ALL ON FUNCTION public.listen_daily_add(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listen_daily_totals(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.listen_daily_add(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.listen_daily_totals(DATE) TO service_role;

CREATE TABLE IF NOT EXISTS public.realtimetts_first_call (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ok          BOOLEAN     NOT NULL,
    status      INTEGER     NOT NULL,  -- HTTP status of the speech call; 0 = no answer; 409 = no free credits, not called
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_realtimetts_first_call_created ON public.realtimetts_first_call(created_at DESC);
ALTER TABLE public.realtimetts_first_call ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role only on realtimetts_first_call" ON public.realtimetts_first_call;
CREATE POLICY "Service role only on realtimetts_first_call" ON public.realtimetts_first_call FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.realtimetts_first_call FROM PUBLIC, anon, authenticated;

COMMIT;
