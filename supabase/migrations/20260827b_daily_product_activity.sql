-- Daily sales/receipts/adjustments audit log, sourced from Droptop's
-- inventory-change-event feed. product_usage (existing) only ever stores a
-- rolling daily_usage RATE recomputed over a lookback window — it has no
-- record of what happened on any specific day. This table is the actual
-- day-by-day ledger.
--
-- Droptop's change_type vocabulary beyond 'sale' and the 'adjustment*'
-- prefix (already read elsewhere in droptop-sync-usage's alerts mode) isn't
-- confirmed yet — nothing in this codebase has inspected a receiving/receipt
-- event. Rather than guess and mislabel, anything that isn't 'sale' or
-- 'adjustment*' is folded into other_qty with its real change_type kept in
-- raw_change_types, so it's visible instead of silently wrong. Once the
-- actual receiving change_type is confirmed (via droptop-sync-usage's
-- existing mode: 'inspect'), split it out into its own received_qty column.
CREATE TABLE IF NOT EXISTS inventory.daily_product_activity (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL,
  location_id      uuid        NOT NULL,
  product_id       text        NOT NULL,
  activity_date    date        NOT NULL,   -- UTC calendar date the events fall on
  category         text,
  sold_qty         numeric     NOT NULL DEFAULT 0,
  adjusted_qty     numeric     NOT NULL DEFAULT 0,  -- net of adjustment-type events; can be +/-
  other_qty        numeric     NOT NULL DEFAULT 0,  -- unclassified change types — see comment above
  raw_change_types text[]      NOT NULL DEFAULT '{}',
  ending_on_hand   numeric,    -- same-day on-hand snapshot, when the pull also fetched inventory
  last_change_source text      NOT NULL DEFAULT 'droptop',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, product_id, activity_date)
);
CREATE INDEX IF NOT EXISTS idx_inv_daily_product_activity_period
  ON inventory.daily_product_activity (company_id, activity_date);

ALTER TABLE inventory.daily_product_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_activity_select" ON inventory.daily_product_activity;
CREATE POLICY "daily_activity_select" ON inventory.daily_product_activity FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Written by the service-role Edge Function only — no direct insert/update
-- policy needed for authenticated users (mirrors count_products, product_usage).
