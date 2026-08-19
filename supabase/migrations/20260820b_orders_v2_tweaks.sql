-- ============================================================
-- Orders v2 — corrections after the first review.
--
--  1. Case-type rules are MINIMUMS, not caps: "the order must include at
--     least 6 bay boxes" (across the shop's order), not "cap each product
--     at 6". Renamed so the name can't mislead later.
--  2. Order minimums can be a dollar total for the order OR a per-product
--     quantity (e.g. bulk must be >= N gallons per product).
--  3. Flag rules: the "last order covered under X days" rule is replaced by
--     "ordered in the last X days AND the days of supply ordered was over Y".
--  4. Order/delivery days come from core.locations.reladyne_delivery_day
--     (RelaDyne only), so the per-shop/vendor day table is dropped.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. Case-type minimums ───────────────────────────────────────────────
ALTER TABLE IF EXISTS inventory.ov2_vendor_case_type_limits
  RENAME TO ov2_vendor_case_type_minimums;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'inventory' AND table_name = 'ov2_vendor_case_type_minimums'
               AND column_name = 'limit_qty') THEN
    ALTER TABLE inventory.ov2_vendor_case_type_minimums RENAME COLUMN limit_qty TO minimum_qty;
  END IF;
END
$$;

COMMENT ON TABLE inventory.ov2_vendor_case_type_minimums IS
  'Per vendor: if a shop orders any of this case type, the order must total at least minimum_qty of it.';

-- ── 2. Dollar vs per-product minimums ───────────────────────────────────
ALTER TABLE inventory.ov2_vendor_order_minimums
  ADD COLUMN IF NOT EXISTS minimum_type text NOT NULL DEFAULT 'dollars',
  ADD COLUMN IF NOT EXISTS minimum_qty  numeric;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ov2_vendor_min_type_chk') THEN
    ALTER TABLE inventory.ov2_vendor_order_minimums
      ADD CONSTRAINT ov2_vendor_min_type_chk
      CHECK (minimum_type IN ('dollars', 'units_per_product', 'gallons_per_product'));
  END IF;
END
$$;

COMMENT ON COLUMN inventory.ov2_vendor_order_minimums.minimum_type IS
  'dollars = whole-order $ floor; units_per_product / gallons_per_product = per-line floor, not an order total.';

-- Company-level defaults get the same choice.
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS package_minimum_type text NOT NULL DEFAULT 'dollars',
  ADD COLUMN IF NOT EXISTS package_minimum_qty  numeric,
  ADD COLUMN IF NOT EXISTS bulk_minimum_type    text NOT NULL DEFAULT 'dollars',
  ADD COLUMN IF NOT EXISTS bulk_minimum_qty     numeric;

-- ── 3. Flag rules ───────────────────────────────────────────────────────
-- Old: "last order's usage covered fewer than X days".
-- New: "ordered within X days" AND "the days of supply ordered exceeded Y".
ALTER TABLE inventory.ov2_settings
  ADD COLUMN IF NOT EXISTS flag_recent_order_days    integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS flag_recent_order_dos_over numeric NOT NULL DEFAULT 30;

ALTER TABLE inventory.ov2_settings
  DROP COLUMN IF EXISTS flag_if_last_order_usage_under;

-- ── 4. Order/delivery days live on the location list ────────────────────
-- core.locations.reladyne_delivery_day already holds the delivery weekday,
-- and the order day is derived from it (delivery − 3 business days), so a
-- parallel table here would just be a second source of truth.
DROP TABLE IF EXISTS inventory.ov2_location_vendor_days;

-- ── 5. days_of_supply_max / skip_order_if_dos_over are soft ─────────────
COMMENT ON COLUMN inventory.ov2_settings.days_of_supply_max IS
  'Soft ceiling: pass 1 fills up to it, but smoothing may exceed it to reach an order minimum.';
COMMENT ON COLUMN inventory.ov2_settings.skip_order_if_dos_over IS
  'Smoothing guard only: a product above this DOS is never pulled onto an order just to reach a minimum. It does not stop a product that is genuinely due from being ordered.';

NOTIFY pgrst, 'reload schema';
