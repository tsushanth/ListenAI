-- backend/supabase/migrations/test_music_jobs.sql
-- Run manually against a local/dev Supabase instance: psql "$DATABASE_URL" -f test_music_jobs.sql
BEGIN;

SELECT create_music_job(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'corporate upbeat instrumental',
    30,
    'test-cache-key-1'
) AS job_id \gset

SELECT status FROM music_jobs WHERE id = :'job_id';
-- Expected before migration runs: ERROR: relation "music_jobs" does not exist
-- Expected after migration runs (Step 4): 'queued'

SELECT (claim_next_music_job()).status;
-- Expected: 'processing'

SELECT update_music_job_status(:'job_id', 'ready', 'music/test/path.wav');
SELECT status, audio_path FROM music_jobs WHERE id = :'job_id';
-- Expected: 'ready', 'music/test/path.wav'

SELECT status FROM get_cached_music('test-cache-key-1');
-- Expected: 'ready'

ROLLBACK;
