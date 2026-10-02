-- 1) Orders backfill throughput (direct ask 2026-10-02: "see what we can do about
--    getting the historical data backfilled"). The month-walk job pulled one
--    shop's WHOLE month per call and a heavy shop-month regularly outran the
--    150s call limit, so the job sat at May 2026 for 12 days pulling ~2 shops a
--    tick. The dispatcher now pulls 7-day windows per shop (the size the routine
--    incremental sync already treats as safe) and only the shops MISSING data
--    for the month. That makes month_pending_ids hold "<shop uuid>|<window>"
--    tokens (Orders) instead of bare uuids, so the column becomes text[]; bare
--    uuids already in it are expanded to windows by the dispatcher.
ALTER TABLE inventory.data_connection_backfill_jobs
  ALTER COLUMN month_pending_ids TYPE text[] USING month_pending_ids::text[];

-- A claim stamp so two ticks (cron overlap, or cron + a manual "Run tick now")
-- never advance the same job at once, which now matters because the cron below
-- fires more often than one tick takes.
ALTER TABLE inventory.data_connection_backfill_jobs
  ADD COLUMN IF NOT EXISTS tick_started_at timestamptz;

-- 2) Critical data connections: an admin-set tag per connection. When a
--    critical connection's last run (scheduled or manual) didn't succeed, the
--    TopBar data-connection icon shows an alert and the panel lists it first.
ALTER TABLE inventory.data_connection_schedules
  ADD COLUMN IF NOT EXISTS is_critical boolean NOT NULL DEFAULT false;
