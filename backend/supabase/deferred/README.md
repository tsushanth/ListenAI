# Deferred migrations

Migrations here are intentionally kept out of `supabase/migrations/` because applying them before a particular release
is live would break the running code. Each file's header says when it is safe. Move it into `migrations/` (with the
next free number) or run it by hand once that condition holds.
