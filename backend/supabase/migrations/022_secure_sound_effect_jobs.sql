-- backend/supabase/migrations/019_secure_sound_effect_jobs.sql
--
-- Ships sound_effect_jobs with RLS locked down from day one, instead of as a
-- follow-up fix. The text-to-music feature branch shipped music_jobs WITHOUT
-- Row Level Security and with its RPCs EXECUTE-able by the public `anon` and
-- `authenticated` Postgres roles by default (Postgres grants EXECUTE on
-- newly created functions to PUBLIC unless revoked), then had to ship a
-- second migration (025_secure_music_jobs.sql) to close that hole after the
-- fact. Since none of the RPCs in 018_add_sound_effect_jobs.sql check
-- auth.uid() internally, leaving that in place here would let any holder of
-- the anon key impersonate any user: read another user's sound_effect_jobs
-- row via get_sound_effect_job_for_user, create jobs billed to an arbitrary
-- user_id, or claim/mutate jobs directly. Applying the fix in this same PR
-- (rather than as a later migration) avoids ever shipping the hole.
--
-- The backend only ever calls these RPCs using the Supabase SERVICE ROLE key
-- (see backend/src/lib/supabaseClient.ts — `supabase` is constructed with
-- SUPABASE_SERVICE_ROLE_KEY). The service role key authenticates as
-- Postgres role `service_role`, which has BYPASSRLS and is not affected by
-- REVOKE ... FROM PUBLIC, anon, authenticated below (those three roles do
-- not include service_role). So this migration does not break the app's own
-- worker/route access to sound_effect_jobs — it only removes access for the
-- anon/authenticated roles that browser/mobile clients authenticate as when
-- using the public anon key or a user JWT directly against PostgREST. This
-- repo's routes/soundEffects.ts never queries sound_effect_jobs directly
-- from the client either; all access goes through the service-role-backed
-- RPCs in supabaseClient.ts.
--
-- RLS policy audit (why each grant below is safe):
--   * `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` with ZERO `CREATE POLICY`
--     statements is intentional, not an oversight: anon/authenticated have
--     no policy granting them any row, so even if they somehow retained
--     table-level SELECT/INSERT/UPDATE/DELETE grants (they don't, see
--     revokes below), RLS still returns zero rows for them. There is no
--     "auth.uid() = user_id" SELECT/UPDATE policy here because there is no
--     legitimate PostgREST-direct access path at all — every real access
--     (by user or by the worker) goes through the RPCs below, all called
--     with the service-role key, which bypasses RLS entirely. Adding a
--     policy that isn't exercised by any real code path would just be
--     surface area to get subtly wrong later.
--   * service_role is unaffected by both the RLS enable and the REVOKEs
--     below (BYPASSRLS + not a member of PUBLIC/anon/authenticated), so the
--     backend's own read/write/claim access is untouched.
--   * Each RPC below is individually REVOKEd from PUBLIC, anon, and
--     authenticated with its exact argument signature (Postgres requires
--     the full signature to disambiguate, even with no overloads), matching
--     025_secure_music_jobs.sql's fix one-for-one for the sound effect
--     table's five equivalent functions.

ALTER TABLE sound_effect_jobs ENABLE ROW LEVEL SECURITY;

-- Deliberately NO CREATE POLICY statements — see audit note above.

REVOKE EXECUTE ON FUNCTION create_sound_effect_job(UUID, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION claim_next_sound_effect_job() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_sound_effect_job_status(UUID, sound_effect_job_status, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_sound_effect_job_for_user(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_cached_sound_effect(TEXT) FROM PUBLIC, anon, authenticated;
