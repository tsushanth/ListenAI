-- backend/supabase/migrations/025_secure_music_jobs.sql
--
-- SECURITY FIX: music_jobs had no Row Level Security enabled, and its RPCs
-- (create_music_job, claim_next_music_job, update_music_job_status,
-- get_music_job_for_user, get_cached_music) were EXECUTE-able by the public
-- `anon` and `authenticated` Postgres roles by default (Postgres grants
-- EXECUTE on newly created functions to PUBLIC unless revoked). Since these
-- RPCs take arbitrary user_id/job_id parameters with no auth.uid() check
-- inside them, any holder of the anon key could impersonate any user: read
-- any other user's music_jobs rows via get_music_job_for_user, create jobs
-- billed to an arbitrary user_id, or claim/mutate jobs directly.
--
-- The backend only ever calls these RPCs using the Supabase SERVICE ROLE
-- key (see backend/src/lib/supabaseClient.ts — `supabase` is constructed
-- with SUPABASE_SERVICE_ROLE_KEY). The service role key authenticates as
-- Postgres role `service_role`, which has BYPASSRLS and is not affected by
-- REVOKE ... FROM PUBLIC, anon, authenticated below (those three roles do
-- not include service_role). So this migration cannot break the app's own
-- RPC calls — it only removes access for the anon/authenticated roles that
-- browser/mobile clients authenticate as when using the public anon key or
-- a user JWT directly against PostgREST.
--
-- Scope: this migration only touches music_jobs and its RPCs. tts_jobs has
-- the same pre-existing gap per a prior reviewer note, but fixing it is out
-- of scope here — it's a separate, already-shipped table and changing its
-- grants needs its own review (e.g. verifying nothing dashboard-side reads
-- tts_jobs directly through PostgREST with the anon key).

ALTER TABLE music_jobs ENABLE ROW LEVEL SECURITY;

-- Deliberately NO CREATE POLICY statements: the app never accesses this
-- table via anon/authenticated PostgREST calls, only via the service role
-- (which bypasses RLS entirely) and the RPCs below. With RLS enabled and
-- zero policies, anon/authenticated get zero rows even if they somehow
-- retained table-level SELECT/INSERT/UPDATE grants.

-- REVOKE EXECUTE on each music_jobs RPC, with the exact argument lists as
-- declared in 024_add_music_jobs.sql (Postgres requires the full signature
-- to disambiguate overloads, even though none of these are overloaded).
REVOKE EXECUTE ON FUNCTION create_music_job(UUID, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION claim_next_music_job() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION update_music_job_status(UUID, music_job_status, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_music_job_for_user(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION get_cached_music(TEXT) FROM PUBLIC, anon, authenticated;
