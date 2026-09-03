-- Fixes the recurring "canceling statement due to statement timeout" on
-- heatmap_rollup_refresh (Customer Heatmap zip rollups). Root cause found
-- 2026-09-03: refresh_heatmap_zip_rollups() (see 20260912_heatmap_zip_
-- rollups.sql / 20260903b below) does two passes over
-- inventory.droptop_orders with no supporting index for either — a
-- touched-dates discovery step filtered by `updated_at` (no index at all
-- on that column), and a follow-up aggregation join keyed on
-- `(order_finalized_at AT TIME ZONE 'UTC')::date` (only a plain btree on
-- the raw timestamp existed, not the truncated-to-date expression). Both
-- forced a full sequential scan of the whole table on every run, which
-- started reliably exceeding statement_timeout once the table grew to
-- ~200k+ rows from this session's historical order backfill. Purely
-- additive — no behavior change, just lets the existing query use an
-- index instead of a seq scan.
CREATE INDEX IF NOT EXISTS idx_droptop_orders_updated_at
  ON inventory.droptop_orders (company_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_droptop_orders_finalized_date_utc
  ON inventory.droptop_orders (company_id, location_id, ((order_finalized_at AT TIME ZONE 'UTC')::date));
