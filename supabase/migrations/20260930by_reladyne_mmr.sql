-- RelaDyne MMR (Monthly Management Report) — direct ask 2026-09-30: a new
-- "RelaDyne" sidebar section (reladyne-logo.svg) with an "MMR" page hosting
-- the vendor-performance data RelaDyne provides monthly: delivered gallons/
-- revenue by shop/product, OTIF (On Time In Full) delivery stats, item fill
-- rate trends, and volume-commitment tracking. Uploaded monthly from 3
-- separate spreadsheet exports; "only adding new rows that are not already
-- there" (direct ask) is implemented as a plain unique constraint per table
-- + the client's own `.upsert(rows, { onConflict: '...', ignoreDuplicates:
-- true })` call — a genuine duplicate (same natural key) is silently
-- skipped, never overwritten, so a re-upload of an already-loaded month is
-- a safe no-op rather than a destructive "last upload wins."
--
-- Deliberately NOT storing the source files' own pre-built pivot sheets
-- (Product Pivot/Bulk Pivot in the Product Gallons workbook, the Volume
-- Summary customer pivot in the MMR workbook) — those are confirmed
-- derivable from reladyne_volume_data's own raw line items via a plain
-- GROUP BY, so storing them separately would just be redundant, harder-to-
-- keep-consistent copies of the same numbers. The one piece that ISN'T
-- derivable from the raw data is the Volume Summary sheet's own embedded
-- Year/Month/Volume Commitment/Volume Actual table (an external target
-- figure, not computed from line items) — that gets its own small table,
-- reladyne_volume_commitment.

-- 1. Raw line-item volume/revenue data — one row per (shop, product, month),
-- from the Product Gallons workbook's own "StricklandData" sheet. Powers
-- the Volume tab (by customer/shop), the Product Gallons tab (by product
-- and by shop+product delivery %), via live SQL aggregation — no separate
-- rollup needed at this row volume (confirmed ~35k rows for 20 months of
-- history in the very first upload, so ~1,750 rows/month going forward;
-- nowhere near the scale where this app's own documented droptop_order_*
-- rollup precedents became necessary).
CREATE TABLE IF NOT EXISTS inventory.reladyne_volume_data (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL,
  customer_name       text,
  customer_no         text        NOT NULL,
  ship_to_name        text,
  ship_to_code        text        NOT NULL,
  product_code        text        NOT NULL,
  product_desc        text        NOT NULL,
  package_group       text,
  gallons_ordered     numeric,
  gallons_billed      numeric,
  revenue             numeric,
  revenue_per_gallon  numeric,
  period              text        NOT NULL, -- 'YYYY-MM', already explicit in the source file
  store_type          text,       -- 'Corporate' | 'Franchise'
  year                integer,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, customer_no, ship_to_code, product_code, period)
);
CREATE INDEX IF NOT EXISTS idx_reladyne_volume_data_period ON inventory.reladyne_volume_data (company_id, period);
CREATE INDEX IF NOT EXISTS idx_reladyne_volume_data_product ON inventory.reladyne_volume_data (company_id, product_desc);

ALTER TABLE inventory.reladyne_volume_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reladyne_volume_data_select" ON inventory.reladyne_volume_data;
CREATE POLICY "reladyne_volume_data_select" ON inventory.reladyne_volume_data FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "reladyne_volume_data_manage" ON inventory.reladyne_volume_data;
CREATE POLICY "reladyne_volume_data_manage" ON inventory.reladyne_volume_data FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- 2. Item fill % trend — one row per (product, month), from the "SBI Item
-- Fill Stat Trend Data" workbook's own "Export" sheet (side-by-side month
-- blocks: ProductCodeDesc/Order Count/Fill Count/Item Fill %). The source
-- file's month labels have no year attached (just "June"/"July"/"August")
-- — the upload UI asks for the reporting year once per upload and applies
-- it to every row parsed from that file.
CREATE TABLE IF NOT EXISTS inventory.reladyne_item_fill_stats (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  product_desc   text        NOT NULL,
  period         text        NOT NULL, -- 'YYYY-MM'
  order_count    integer,
  fill_count     integer,
  item_fill_pct  numeric,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_desc, period)
);
CREATE INDEX IF NOT EXISTS idx_reladyne_item_fill_stats_period ON inventory.reladyne_item_fill_stats (company_id, period);

ALTER TABLE inventory.reladyne_item_fill_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reladyne_item_fill_stats_select" ON inventory.reladyne_item_fill_stats;
CREATE POLICY "reladyne_item_fill_stats_select" ON inventory.reladyne_item_fill_stats FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "reladyne_item_fill_stats_manage" ON inventory.reladyne_item_fill_stats;
CREATE POLICY "reladyne_item_fill_stats_manage" ON inventory.reladyne_item_fill_stats FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- 3. OTIF (On Time In Full) delivery stats — one row per (segment, month),
-- from the MMR workbook's 4 "OTIF 90" sheets (Corp/Fz x Bulk/Package).
-- Same no-year-in-source-labels situation as item fill stats above — the
-- upload UI's reporting-year field applies here too (both come from the
-- same upload flow/modal).
CREATE TABLE IF NOT EXISTS inventory.reladyne_otif_stats (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL,
  segment       text        NOT NULL CHECK (segment IN ('corp_bulk', 'fz_bulk', 'corp_package', 'fz_package')),
  period        text        NOT NULL, -- 'YYYY-MM'
  otif_pct      numeric,
  on_time_pct   numeric,
  in_full_pct   numeric,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, segment, period)
);
CREATE INDEX IF NOT EXISTS idx_reladyne_otif_stats_period ON inventory.reladyne_otif_stats (company_id, period);

ALTER TABLE inventory.reladyne_otif_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reladyne_otif_stats_select" ON inventory.reladyne_otif_stats;
CREATE POLICY "reladyne_otif_stats_select" ON inventory.reladyne_otif_stats FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "reladyne_otif_stats_manage" ON inventory.reladyne_otif_stats;
CREATE POLICY "reladyne_otif_stats_manage" ON inventory.reladyne_otif_stats FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- 4. Volume commitment vs actual — one row per (year, month), from the MMR
-- workbook's Volume Summary sheet's own embedded Year/Month/Volume
-- Commitment (Gal)/Volume Actual (Gal)/% table (columns AC-AE in that
-- sheet) — an external target figure set by the business relationship,
-- not something derivable from the raw line items. This table's own
-- source rows DO carry an explicit year, unlike the other two above.
CREATE TABLE IF NOT EXISTS inventory.reladyne_volume_commitment (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL,
  year                    integer     NOT NULL,
  month                   text        NOT NULL, -- full month name, e.g. 'August'
  period                  text        NOT NULL, -- 'YYYY-MM', computed at insert time for consistent sorting/joining with the other tables
  volume_commitment_gal   numeric,
  volume_actual_gal       numeric,
  pct                     numeric,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, year, month)
);
CREATE INDEX IF NOT EXISTS idx_reladyne_volume_commitment_period ON inventory.reladyne_volume_commitment (company_id, period);

ALTER TABLE inventory.reladyne_volume_commitment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reladyne_volume_commitment_select" ON inventory.reladyne_volume_commitment;
CREATE POLICY "reladyne_volume_commitment_select" ON inventory.reladyne_volume_commitment FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "reladyne_volume_commitment_manage" ON inventory.reladyne_volume_commitment;
CREATE POLICY "reladyne_volume_commitment_manage" ON inventory.reladyne_volume_commitment FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
