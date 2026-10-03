-- Orders data repair job (direct ask 2026-10-03). The 2026-10-02/03 Orders
-- backfill ran while the database was saturated; the sync function saved the
-- orders but some of their child rows (packages / services / taxes ...) failed
-- to insert, and the backfill counted those warnings as success. A sample shows
-- 5-9% of orders in Sep 2025 / Dec 2025 / Jan 2026 with no package rows against
-- ~0.5% normally. This adds a second kind of job on the same table that scans a
-- month for shop-weeks with too many package-less orders, re-pulls only those,
-- and re-scans to verify — slowly, in a nightly window, and backing off when it
-- sees timeouts (see data-connection-backfill-dispatcher's tickRepairJob).

ALTER TABLE inventory.data_connection_backfill_jobs
  ADD COLUMN IF NOT EXISTS job_kind text NOT NULL DEFAULT 'backfill',
  -- "<shop uuid>|<window 0-3>|<attempts>" tokens still to re-pull for cursor_month; NULL = scan the month next tick
  ADD COLUMN IF NOT EXISTS repair_pending text[],
  ADD COLUMN IF NOT EXISTS repair_round integer NOT NULL DEFAULT 0,
  -- "<shop uuid>|<window>" shop-weeks that still weren't clean after the max attempts/rounds
  ADD COLUMN IF NOT EXISTS repair_gave_up text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS repair_found integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repair_fixed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused_until timestamptz,
  ADD COLUMN IF NOT EXISTS consecutive_stress integer NOT NULL DEFAULT 0;

ALTER TABLE inventory.data_connection_backfill_jobs DROP CONSTRAINT IF EXISTS data_connection_backfill_jobs_job_kind_chk;
ALTER TABLE inventory.data_connection_backfill_jobs
  ADD CONSTRAINT data_connection_backfill_jobs_job_kind_chk CHECK (job_kind IN ('backfill', 'repair'));

-- Per shop, over a UTC date range: how many Finalized orders there are and how
-- many have NO package row. Read-only, one window at a time (~50k orders) so it
-- stays cheap; capped at 60s so it can never run away on a struggling database.
CREATE OR REPLACE FUNCTION public.find_incomplete_order_windows(p_start date, p_end date)
RETURNS TABLE (location_id uuid, orders bigint, missing bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET statement_timeout = '60s'
AS $$
  SELECT o.location_id,
         count(*) AS orders,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM inventory.droptop_order_packages p WHERE p.order_id = o.id)) AS missing
  FROM inventory.droptop_orders o
  WHERE o.status = 'Finalized'
    AND o.order_finalized_at >= (p_start::timestamp AT TIME ZONE 'UTC')
    AND o.order_finalized_at <  ((p_end + 1)::timestamp AT TIME ZONE 'UTC')
  GROUP BY o.location_id
$$;
REVOKE ALL ON FUNCTION public.find_incomplete_order_windows(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_incomplete_order_windows(date, date) TO service_role;

NOTIFY pgrst, 'reload schema';
