-- backend/supabase/rollbacks/037_rollback.sql
-- Roll the backend back first (it keeps working without these, logging a warning).
DROP FUNCTION IF EXISTS public.listen_daily_totals(DATE);
DROP FUNCTION IF EXISTS public.listen_daily_add(JSONB);
DROP TABLE IF EXISTS public.listen_daily;
DROP TABLE IF EXISTS public.realtimetts_first_call;
