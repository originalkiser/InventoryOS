-- Month End expectations engine — config tables + count-summary/recount columns.
-- Foundation for product-level "expected on hand" recount tracking.
-- Safe to re-run: all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--
-- Adds:
--   inventory.category_simplification   detailed category -> Parts/Oil/Additives
--   inventory.category_expectations     per-category on-hand upper limits (CPD tiers + engine-oil case types)
--   inventory.location_cpd              cars-per-day by location (its own upload)
--   inventory.counts.oil_adjustments    oil-specific adjustment count (for the < 5 rule)
--   inventory.recount_config.oil_*_adj  oil adjustment-count thresholds
--
-- The server-side analysis RPC (get_product_expectation_exceptions) ships in a
-- follow-up migration once the engine UI is wired.

-- ── shared RLS helper: rows are visible to members of the owning company ────
-- (mirrors the inventory.counts policy pattern)

-- ===========================================================================
-- 1. Category simplification — detailed category -> Parts / Oil / Additives
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.category_simplification (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  category           text        NOT NULL,
  simple_category    text,       -- 'Parts' | 'Oil' | 'Additives' | NULL (excluded)
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_cat_simpl_company
  ON inventory.category_simplification (company_id);

ALTER TABLE inventory.category_simplification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cat_simpl_select" ON inventory.category_simplification;
CREATE POLICY "cat_simpl_select" ON inventory.category_simplification FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_simpl_insert" ON inventory.category_simplification;
CREATE POLICY "cat_simpl_insert" ON inventory.category_simplification FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_simpl_update" ON inventory.category_simplification;
CREATE POLICY "cat_simpl_update" ON inventory.category_simplification FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_simpl_delete" ON inventory.category_simplification;
CREATE POLICY "cat_simpl_delete" ON inventory.category_simplification FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ===========================================================================
-- 2. Category expectations — on-hand UPPER limits per category
--    Non-oil categories: two CPD tiers (0-30 cars/day, 30+ cars/day).
--    Engine oil (is_engine_oil = true): limits by case type instead of CPD.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.category_expectations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  category           text        NOT NULL,
  cpd_0_30_limit     numeric,    -- upper limit when shop CPD <= 30
  cpd_30plus_limit   numeric,    -- upper limit when shop CPD > 30
  is_engine_oil      boolean     NOT NULL DEFAULT false,
  oil_bulk_limit     numeric,    -- numeric SKU suffix (bulk)
  oil_package_limit  numeric,    -- letter suffix: BB / C / J (bay box, case, jug)
  oil_drum_limit     numeric,    -- letter suffix: D (drum)
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_cat_expect_company
  ON inventory.category_expectations (company_id);

ALTER TABLE inventory.category_expectations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cat_expect_select" ON inventory.category_expectations;
CREATE POLICY "cat_expect_select" ON inventory.category_expectations FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_expect_insert" ON inventory.category_expectations;
CREATE POLICY "cat_expect_insert" ON inventory.category_expectations FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_expect_update" ON inventory.category_expectations;
CREATE POLICY "cat_expect_update" ON inventory.category_expectations FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "cat_expect_delete" ON inventory.category_expectations;
CREATE POLICY "cat_expect_delete" ON inventory.category_expectations FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ===========================================================================
-- 3. Location CPD — cars-per-day by location (its own upload)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.location_cpd (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid,
  cpd                numeric,
  effective_month    date,       -- optional period tag; NULL = current/default
  metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by         uuid,
  last_change_source text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_location_cpd_company
  ON inventory.location_cpd (company_id, location_id);

ALTER TABLE inventory.location_cpd ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "location_cpd_select" ON inventory.location_cpd;
CREATE POLICY "location_cpd_select" ON inventory.location_cpd FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_cpd_insert" ON inventory.location_cpd;
CREATE POLICY "location_cpd_insert" ON inventory.location_cpd FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_cpd_update" ON inventory.location_cpd;
CREATE POLICY "location_cpd_update" ON inventory.location_cpd FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_cpd_delete" ON inventory.location_cpd;
CREATE POLICY "location_cpd_delete" ON inventory.location_cpd FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ===========================================================================
-- 4. Oil adjustment count — summary column + recount thresholds
-- ===========================================================================
ALTER TABLE inventory.counts
  ADD COLUMN IF NOT EXISTS oil_adjustments numeric;

ALTER TABLE inventory.recount_config
  ADD COLUMN IF NOT EXISTS oil_low_adj_threshold  numeric,
  ADD COLUMN IF NOT EXISTS oil_high_adj_threshold numeric;
