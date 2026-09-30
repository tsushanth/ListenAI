-- ============================================================================
-- Migration: Lock the realtime-tts billing tables to the service role
--
-- 012 (realtimetts_billing) and the api-keys migration created their "Service role full access"
-- policies without a role, i.e. FOR ALL TO PUBLIC USING (true), and anon/authenticated hold full
-- table grants. The site ships the anon key, so anyone could read, insert, edit or delete rows
-- through Supabase's REST API -- e.g. mark themselves billing-active (or, with 028, comped).
-- Only the backend (service_role, which bypasses RLS anyway) ever touches these tables; nothing in
-- web/, ios/ or android/ references them.
-- ============================================================================

DROP POLICY IF EXISTS "Service role full access on realtimetts_billing" ON realtimetts_billing;
CREATE POLICY "Service role full access on realtimetts_billing" ON realtimetts_billing
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_billing FROM anon, authenticated;

DROP POLICY IF EXISTS "Service role full access on realtimetts_api_keys" ON realtimetts_api_keys;
CREATE POLICY "Service role full access on realtimetts_api_keys" ON realtimetts_api_keys
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON realtimetts_api_keys FROM anon, authenticated;
