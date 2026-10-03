-- Backfill/repair dispatcher cron: every 5 min. Repair ticks are small (<= 8 sequential calls) and self-gated
-- to a nightly window, so this is what spaces them; backfill jobs have their own claim lock.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'data-connection-backfill-dispatcher'),
  schedule := '*/5 * * * *'
);
