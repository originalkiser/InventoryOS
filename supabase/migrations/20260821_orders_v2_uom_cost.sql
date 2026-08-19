-- ============================================================
-- Orders v2 — automatic UOM/cost resolution from vendor parts, plus a
-- vendor-scoped UOM→quarts conversion table and vendor part price history.
--
--  0. inventory.uom_mappings turns out not to exist — it's still
--     core.uom_mappings. Same story as the vendors/vendor_parts move in
--     20260818d (whose own comment claims uom_mappings was already in
--     inventory — it wasn't; nobody had verified it since nothing had ever
--     populated the table to notice the schema mismatch). Every
--     `.schema('inventory').from('uom_mappings')` call in the app — this
--     config tab and the legacy Orders module's UOM conversion — has been
--     silently getting zero rows. Moved here first so the rest of this
--     migration has something to alter.
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

-- ── 0. Move uom_mappings to where the rest of the schema already assumes
-- it lives. Metadata-only, instant, RLS/indexes move automatically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'uom_mappings')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'inventory' AND table_name = 'uom_mappings') THEN
    ALTER TABLE core.uom_mappings SET SCHEMA inventory;
  END IF;
END
$$;

-- ── 1. Vendor-scoped UOM conversions ────────────────────────────────────
ALTER TABLE inventory.uom_mappings
  ADD COLUMN IF NOT EXISTS vendor_id uuid;

COMMENT ON COLUMN inventory.uom_mappings.vendor_id IS
  'Optional — a UOM name can mean a different size per vendor. NULL applies to any vendor using that UOM name.';

-- Looked up by shape rather than by a guessed name — the original migration
-- (Uploaded/phase8_uom_conversion.sql) named it via Postgres's default
-- convention, but that's exactly the kind of thing that drifts, and a wrong
-- guess here is a silent no-op that leaves the OLD constraint blocking the
-- very thing this migration adds: a global mapping and a vendor-specific
-- mapping coexisting for the same UOM name.
DO $$
DECLARE old_con text;
BEGIN
  SELECT c.conname INTO old_con
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'inventory' AND t.relname = 'uom_mappings' AND c.contype = 'u'
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) AND a.attname = 'vendor_id'
    )
  LIMIT 1;
  IF old_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE inventory.uom_mappings DROP CONSTRAINT %I', old_con);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'inventory' AND t.relname = 'uom_mappings' AND c.conname = 'uom_mappings_company_vendor_from_to_key'
  ) THEN
    ALTER TABLE inventory.uom_mappings
      ADD CONSTRAINT uom_mappings_company_vendor_from_to_key UNIQUE (company_id, vendor_id, from_unit, to_unit);
  END IF;
END
$$;

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
