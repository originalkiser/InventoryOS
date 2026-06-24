-- Create inventory-schema count tables and migrate data from legacy public tables.
-- Safe to re-run: all DDL uses IF NOT EXISTS / OR REPLACE.

-- ── inventory.counts (replaces public.monthly_counts) ──────────────────────
CREATE TABLE IF NOT EXISTS inventory.counts (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL,
  location_id            uuid,
  count_date             timestamptz NOT NULL DEFAULT now(),
  count_month            date,
  count_type             text,
  total_adjustments      numeric,
  adjustment_value       numeric,
  abs_adjustment_value   numeric,
  ending_inventory_cost  numeric,
  upload_batch_id        uuid,
  uploaded_at            timestamptz DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_counts_company_month
  ON inventory.counts (company_id, count_month);

ALTER TABLE inventory.counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "counts_select" ON inventory.counts;
CREATE POLICY "counts_select" ON inventory.counts FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "counts_insert" ON inventory.counts;
CREATE POLICY "counts_insert" ON inventory.counts FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "counts_update" ON inventory.counts;
CREATE POLICY "counts_update" ON inventory.counts FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "counts_delete" ON inventory.counts;
CREATE POLICY "counts_delete" ON inventory.counts FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── inventory.count_products (replaces public.monthly_count_products) ───────
CREATE TABLE IF NOT EXISTS inventory.count_products (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid    NOT NULL,
  upload_batch_id uuid,
  location_id     uuid,
  product_id      text    NOT NULL,
  category        text,
  on_hand         numeric,
  sold            numeric,
  adjusted        numeric,
  ending_value    numeric,
  count_month     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_count_products_company_month
  ON inventory.count_products (company_id, count_month);

ALTER TABLE inventory.count_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "count_products_select" ON inventory.count_products;
CREATE POLICY "count_products_select" ON inventory.count_products FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "count_products_insert" ON inventory.count_products;
CREATE POLICY "count_products_insert" ON inventory.count_products FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "count_products_delete" ON inventory.count_products;
CREATE POLICY "count_products_delete" ON inventory.count_products FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── inventory.count_batches (new — tracks product-detail upload batches) ────
CREATE TABLE IF NOT EXISTS inventory.count_batches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  module       text        NOT NULL DEFAULT 'monthly'
                             CHECK (module IN ('monthly', 'weekly')),
  count_month  date,
  file_name    text,
  source_type  text        DEFAULT 'file'
                             CHECK (source_type IN ('file', 'api', 'google_sheets', 'onedrive', 'sharepoint')),
  uploaded_by  uuid,
  row_count    integer     NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_count_batches_company_month
  ON inventory.count_batches (company_id, module, count_month);

ALTER TABLE inventory.count_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "count_batches_select" ON inventory.count_batches;
CREATE POLICY "count_batches_select" ON inventory.count_batches FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "count_batches_insert" ON inventory.count_batches;
CREATE POLICY "count_batches_insert" ON inventory.count_batches FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "count_batches_delete" ON inventory.count_batches;
CREATE POLICY "count_batches_delete" ON inventory.count_batches FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ── Migrate existing data from public schema (idempotent via ON CONFLICT DO NOTHING) ──
INSERT INTO inventory.counts (
  id, company_id, location_id, count_date, count_month,
  count_type, total_adjustments, adjustment_value, abs_adjustment_value,
  ending_inventory_cost, upload_batch_id, uploaded_at, created_at, updated_at
)
SELECT
  id, company_id, location_id,
  COALESCE(count_date, created_at)  AS count_date,
  count_month,
  count_type, total_adjustments, adjustment_value,
  abs_adjustment_value,
  ending_inventory_cost,
  upload_batch_id,
  COALESCE(uploaded_at, created_at) AS uploaded_at,
  created_at, updated_at
FROM public.monthly_counts
ON CONFLICT (id) DO NOTHING;

INSERT INTO inventory.count_products (
  id, company_id, upload_batch_id, location_id, product_id,
  category, on_hand, sold, adjusted, ending_value, count_month,
  created_at, updated_at
)
SELECT
  id, company_id, upload_batch_id, location_id, product_id,
  category, on_hand, sold, adjusted, ending_value, count_month,
  created_at, updated_at
FROM public.monthly_count_products
ON CONFLICT (id) DO NOTHING;

-- ── Refresh the aggregation RPC to ensure correct schema path ──────────────
CREATE OR REPLACE FUNCTION public.get_aggregated_monthly_products(
  p_company_id  uuid,
  p_count_month text
)
RETURNS TABLE (
  location_id   uuid,
  product_id    text,
  category      text,
  on_hand       numeric,
  sold          numeric,
  adjusted      numeric,
  ending_value  numeric,
  batch_count   bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    cp.location_id,
    cp.product_id::text,
    MAX(cp.category)::text                    AS category,
    SUM(COALESCE(cp.on_hand, 0))::numeric     AS on_hand,
    SUM(COALESCE(cp.sold, 0))::numeric        AS sold,
    SUM(COALESCE(cp.adjusted, 0))::numeric    AS adjusted,
    SUM(COALESCE(cp.ending_value, 0))::numeric AS ending_value,
    COUNT(DISTINCT cp.upload_batch_id)::bigint AS batch_count
  FROM inventory.count_products cp
  WHERE cp.company_id  = p_company_id
    AND cp.count_month = p_count_month::date
  GROUP BY cp.location_id, cp.product_id
$$;

GRANT EXECUTE ON FUNCTION public.get_aggregated_monthly_products(uuid, text) TO authenticated;
