-- ============================================================================
-- Migration 031: Make the two public storage buckets private
--
-- Companion to 030_lock_open_tables.sql (same audit, same day).
--
-- Problem: the `audio-files` and `cloned-voices` buckets are created
-- out-of-band (no migration defines them) and carry policies on
-- storage.objects that let the public anon key — the key shipped in the web
-- bundle — upload to them. The buckets themselves are also public, so objects
-- were readable without any signature.
--
-- Safety verified before writing this (2026-10-03):
--   * No client ever uses a public URL: `getPublicUrl`, `/object/public/`,
--     `publicUrl` and `public_url` do not appear anywhere in web/, ios/,
--     android/ or backend/ (grep across .ts/.tsx/.swift/.kt/.java/.js).
--   * Every read is a backend-issued signed URL (createSignedUrl) and every
--     client upload is a backend-issued signed upload URL
--     (createSignedUploadUrl) — both keep working on a private bucket.
--   * The backend uses the service_role key, which bypasses RLS entirely.
--   * So flipping the buckets private and denying anon/authenticated access to
--     these two buckets changes no working code path.
--
-- Assumes RLS is enabled on storage.objects (Supabase default). Verify once
-- with:  select relrowsecurity from pg_class where oid = 'storage.objects'::regclass;
-- If that ever returns false, the policy below is inert and the grants must be
-- tightened instead — do not revoke storage.objects grants blindly, it affects
-- every bucket.
--
-- Idempotent: safe to run repeatedly. Rollback: ../rollbacks/031_rollback.sql.
-- (Rollbacks live OUTSIDE supabase/migrations/ on purpose: `supabase db push`
-- applies every *.sql whose name matches <version>_name.sql, including
-- *_rollback.sql, which would undo this migration.)
-- ============================================================================

begin;

-- 1. Buckets stop serving objects without a signature.
update storage.buckets
   set public = false
 where id in ('audio-files', 'cloned-voices');

-- 2. Deny anon/authenticated any access to just these two buckets, regardless
--    of whatever permissive policy the dashboard created (unknown name).
--    A RESTRICTIVE policy ANDs with every permissive policy, so it holds even
--    if a broad "allow public uploads" policy is present. bucket_id NOT IN (...)
--    leaves every other bucket untouched.
drop policy if exists "deny anon access to private audio buckets" on storage.objects;
create policy "deny anon access to private audio buckets" on storage.objects
  as restrictive
  for all
  to anon, authenticated
  using (bucket_id not in ('audio-files', 'cloned-voices'))
  with check (bucket_id not in ('audio-files', 'cloned-voices'));

commit;
