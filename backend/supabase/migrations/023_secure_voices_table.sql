-- ============================================================================
-- Migration: Enable RLS on the voices table
-- ============================================================================
-- public.voices had RLS disabled, flagged by Supabase's own security advisor:
-- with RLS off, the anon and authenticated Postgres roles (what any client
-- using the publishable/anon key or a raw user JWT authenticates as) can
-- read AND write every row directly via PostgREST, bypassing the app
-- entirely.
--
-- Only backend/src/lib/supabaseClient.ts queries this table today, always
-- via the service-role key (which has BYPASSRLS and is unaffected by
-- anything below), so enabling RLS here changes nothing about how the app
-- actually works.
--
-- voices is a catalog of available TTS voices (name, provider, sample audio,
-- tier_required, etc.) with no per-user ownership column — there is no
-- "auth.uid() = owner" policy to write here, because there is no owner.
-- Catalog data like this is meant to be publicly listable (same posture a
-- product's own /voices page would need if it ever queries this table
-- client-side), so this grants SELECT on active voices to anon and
-- authenticated, and leaves INSERT/UPDATE/DELETE ungranted — only the
-- service-role-backed backend can manage the catalog.

ALTER TABLE voices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access to active voices"
    ON voices FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

-- No INSERT/UPDATE/DELETE policies: catalog management stays service-role only.
