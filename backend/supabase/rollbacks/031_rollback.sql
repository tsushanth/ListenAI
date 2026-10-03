-- ============================================================================
-- Rollback for 031_lock_storage_buckets.sql: removes the restrictive policy so
-- anon/authenticated access to the buckets behaves as it did before (whatever
-- permissive policies already existed). Only use to recover from an outage
-- caused by 031. Idempotent.
-- ============================================================================

begin;

drop policy if exists "deny anon access to private audio buckets" on storage.objects;

-- Uncomment only to fully reverse 031, including public read:
-- update storage.buckets set public = true where id in ('audio-files', 'cloned-voices');

commit;
