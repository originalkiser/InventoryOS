-- Background (run-and-forget) historical backfills for the 3 Droptop
-- connections that need one: Orders, Staff Time Clock, and Usage. Today's
-- "Historical X Backfill" cards on Data Connections run entirely in the
-- browser (a client-side loop calling the sync Edge Function chunk by
-- chunk) — closing the tab, a hard refresh, or the computer sleeping kills
-- it outright (see CLAUDE.md's own "Background sync progress" note, which
-- already documents this as a known limitation of that design). This table
-- is job state a new cron-driven dispatcher (data-connection-backfill-
-- dispatcher, registered below) advances one bounded tick at a time,
-- independent of any browser tab.
--
-- Orders and Staff Time Clock both support pulling an explicit past date
-- range (droptop-sync-orders/droptop-sync-staff-time-clock's own 'sync'
-- mode), so their job type walks backward month by month, checking each
-- month's coverage via the existing Data Health RPCs
-- (get_droptop_{orders,time_clock}_daily_coverage) before deciding whether
-- to actually pull it — a month already well-covered (>= min_coverage_pct
-- of the job's target shops) is skipped rather than re-pulled.
--
-- Usage is different: droptop-sync-usage has no explicit date-range mode at
-- all (Droptop's usage/inventory API is a live-state snapshot, not a
-- queryable historical ledger — see that function's own POST-body doc
-- comment, daysBack only ever counts back from right now) — there is no
-- "usage as of March 2025" to ask for. Its backfill is really just "pull
-- today's real 30-day window once, per shop, instead of waiting a month for
-- the rolling average to build up" — a flat one-shot job over a shop list,
-- no month-walking or coverage-checking involved.
CREATE TABLE IF NOT EXISTS inventory.data_connection_backfill_jobs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  connection_key            text        NOT NULL CHECK (connection_key IN ('droptop_orders', 'droptop_usage', 'droptop_time_clock')),
  status                    text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'error')),
  location_ids              uuid[]      NOT NULL,
  -- Orders / Staff Time Clock only — the month-by-month backward walk.
  cursor_month              date,
  floor_month               date        NOT NULL DEFAULT (date_trunc('month', now()) - interval '24 months')::date,
  min_coverage_pct          numeric     NOT NULL DEFAULT 0.85,
  months_pulled             integer     NOT NULL DEFAULT 0,
  months_skipped            integer     NOT NULL DEFAULT 0,
  -- Usage only — flat per-shop progress, no month concept.
  usage_pending_location_ids uuid[],
  usage_done_count          integer     NOT NULL DEFAULT 0,
  last_run_at               timestamptz,
  last_tick_summary         text,
  error_message             text,
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- One active job per connection per company at a time — starting a new one
-- while another's still running would just race the same shops/months.
CREATE UNIQUE INDEX IF NOT EXISTS idx_backfill_jobs_one_running
  ON inventory.data_connection_backfill_jobs (company_id, connection_key) WHERE status = 'running';

ALTER TABLE inventory.data_connection_backfill_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "data_connection_backfill_jobs_select" ON inventory.data_connection_backfill_jobs;
CREATE POLICY "data_connection_backfill_jobs_select" ON inventory.data_connection_backfill_jobs FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "data_connection_backfill_jobs_manage" ON inventory.data_connection_backfill_jobs;
CREATE POLICY "data_connection_backfill_jobs_manage" ON inventory.data_connection_backfill_jobs FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.data_connection_backfill_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.data_connection_backfill_jobs TO service_role;

-- The Data Health coverage RPCs (20260930i) were only ever granted to
-- `authenticated` (that page is always loaded by a logged-in user) — the
-- new dispatcher calls them as service_role via a plain Postgres function
-- call (not PostgREST), which still needs its own EXECUTE grant.
GRANT EXECUTE ON FUNCTION public.get_droptop_orders_daily_coverage(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_droptop_time_clock_daily_coverage(date, date) TO service_role;

NOTIFY pgrst, 'reload schema';
