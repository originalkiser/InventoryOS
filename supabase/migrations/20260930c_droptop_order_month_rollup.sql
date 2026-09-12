-- Historical Backfill Plan's Orders/Shops columns (Config -> Data
-- Connections) used to call get_droptop_order_month_stats (migration
-- 20260918) directly on every page load, grouping the WHOLE tracked
-- range (15+ months) in one query. That was confirmed fine via EXPLAIN
-- ANALYZE at the time (~4s, well inside the 'authenticated' role's 30s
-- statement_timeout) — but inventory.droptop_orders has grown enough
-- since that this now blows the timeout outright ("canceling statement
-- due to statement timeout"), even though the actual RESULT is only
-- ~15-20 tiny rows. The cost was always in scanning the full tracked
-- range, not in what came back.
--
-- Fix: read from this small pre-computed table instead (a plain SELECT
-- over ~15-20 rows can never time out, no matter how large droptop_orders
-- gets) and recompute it on demand via a "Refresh Stats" button
-- (DataConnectionsTab.tsx's refreshMonthStats) rather than automatically
-- on every page load. The refresh itself calls the EXISTING
-- get_droptop_order_month_stats RPC once PER MONTH (a single-month range
-- each call) instead of once for the whole multi-month range — a
-- single-month scan stays index-friendly regardless of how large the
-- table grows overall, which is what actually fixes the underlying cost,
-- not just moving where the query result gets cached.
CREATE TABLE IF NOT EXISTS inventory.droptop_order_month_rollup (
  company_id  uuid        NOT NULL,
  year_month  text        NOT NULL,  -- 'YYYY-MM'
  orders      integer     NOT NULL DEFAULT 0,
  shops       integer     NOT NULL DEFAULT 0,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year_month)
);

ALTER TABLE inventory.droptop_order_month_rollup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_order_month_rollup_select" ON inventory.droptop_order_month_rollup;
CREATE POLICY "droptop_order_month_rollup_select" ON inventory.droptop_order_month_rollup FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written directly by the "Refresh Stats" button (a real logged-in
-- admin/user session, not a service-role job) — this is a lightweight
-- on-demand cache for one config-page checklist, not sensitive data, so
-- any authenticated company member who can already see this page can
-- also refresh it (matches the page's own department-based access model
-- rather than adding a separate role check this table alone would need).
DROP POLICY IF EXISTS "droptop_order_month_rollup_manage" ON inventory.droptop_order_month_rollup;
CREATE POLICY "droptop_order_month_rollup_manage" ON inventory.droptop_order_month_rollup FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
