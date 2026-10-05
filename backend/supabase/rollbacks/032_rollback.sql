-- ============================================================================
-- Rollback for 032_stt_retention_and_key_settings.sql. Idempotent.
-- Drops the purge job/function and the per-key settings table, and the new stt_transcriptions columns.
-- Only use if the backend that reads them has been rolled back first (the new routes insert these columns).
-- ============================================================================

begin;

do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(jobid) from cron.job where jobname = 'purge-expired-stt-transcripts';
    end if;
end
$$;

drop function if exists purge_expired_stt_transcripts();
drop table if exists stt_key_settings;
drop index if exists idx_stt_transcriptions_expires_at;
alter table stt_transcriptions
    drop column if exists surface,
    drop column if exists keyterm_count,
    drop column if exists retention_days,
    drop column if exists expires_at;

commit;
