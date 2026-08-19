-- ============================================================
-- Orders v2 — automatic UOM/cost resolution from vendor parts, plus a
-- vendor-scoped UOM→quarts conversion table and vendor part price history.
--
--  1. inventory.ov2_product_rules (units_per_uom_gallons, unit_cost) has no
--     editing UI and is empty in every company — every generation run has
--     been falling back to "1 gallon-equivalent per package unit" and a
--     null cost. The app-side fix resolves both automatically from
--     inventory.vendor_parts (falling back to it only when no explicit
--     ov2_product_rules override exists), so this migration does not touch
--     that table. It stays available as a future per-shop override layer.
--  2. inventory.uom_mappings gets a nullable vendor_id (a UOM like "Drum"
--     can mean a different size for different vendors) so it can double as
--     the quarts-per-package lookup for Orders v2, alongside its existing
--     use in the legacy Orders module.
--  3. inventory.vendor_part_price_history — a row per price change, written
--     by the app (VendorPartsTab) on manual edit and file upload, not by a
--     trigger, so it can capture who/what-source alongside the price.
--  4. ov2_order_draft_lines / ov2_order_history_lines gain quarts_per_unit,
--     the conversion factor actually used at generation time, snapshotted
--     the same way max_capacity_gallons already is — so review/export/
--     history can show "qty ordered, in quarts" without re-deriving it.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. Vendor-scoped UOM conversions ────────────────────────────────────
ALTER TABLE inventory.uom_mappings
  ADD COLUMN IF NOT EXISTS vendor_id uuid;

COMMENT ON COLUMN inventory.uom_mappings.vendor_id IS
  'Optional — a UOM name can mean a different size per vendor. NULL applies to any vendor using that UOM name.';

ALTER TABLE inventory.uom_mappings DROP CONSTRAINT IF EXISTS uom_mappings_company_id_from_unit_to_unit_key;
ALTER TABLE inventory.uom_mappings
  ADD CONSTRAINT uom_mappings_company_vendor_from_to_key UNIQUE (company_id, vendor_id, from_unit, to_unit);

CREATE INDEX IF NOT EXISTS idx_uom_mappings_vendor
  ON inventory.uom_mappings (company_id, vendor_id);

-- ── 2. Vendor part price history ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory.vendor_part_price_history (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  vendor_part_id     uuid        NOT NULL,
  price_per_gallon   numeric,
  price_per_package  numeric,
  source             text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'upload')),
  changed_by         uuid,
  changed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_part_price_history_part
  ON inventory.vendor_part_price_history (vendor_part_id, changed_at DESC);

ALTER TABLE inventory.vendor_part_price_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_part_price_history_rw ON inventory.vendor_part_price_history;
CREATE POLICY vendor_part_price_history_rw ON inventory.vendor_part_price_history FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── 3. Snapshot the conversion factor used, on each order line ─────────
ALTER TABLE inventory.ov2_order_draft_lines
  ADD COLUMN IF NOT EXISTS quarts_per_unit numeric;
ALTER TABLE inventory.ov2_order_history_lines
  ADD COLUMN IF NOT EXISTS quarts_per_unit numeric;

NOTIFY pgrst, 'reload schema';
