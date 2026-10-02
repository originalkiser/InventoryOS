-- Backfill dispatcher cron: every 10 min -> every 3 min. Applied AFTER the lock-aware dispatcher
-- (tick_started_at claim, see 20260930cj) is deployed — without the claim, overlapping ticks would race.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'data-connection-backfill-dispatcher'),
  schedule := '*/3 * * * *'
);
