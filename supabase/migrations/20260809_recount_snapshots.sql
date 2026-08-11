-- Stored snapshots of the flagged recount-product list, captured per run so the
-- Review tab can diff day-over-day (which products came off / were added) as the
-- recount period progresses. Each capture shares a run_id + run_at.
CREATE TABLE IF NOT EXISTS inventory.recount_product_snapshots (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL,
  count_month    date        NOT NULL,
  run_id         uuid        NOT NULL,
  run_at         timestamptz NOT NULL DEFAULT now(),
  location_id    uuid,
  product_id     text        NOT NULL,
  category       text,
  on_hand        numeric,
  expected_limit numeric,
  basis          text,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recount_snap_company_month
  ON inventory.recount_product_snapshots (company_id, count_month, run_at DESC);

ALTER TABLE inventory.recount_product_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recount_snap_select" ON inventory.recount_product_snapshots;
CREATE POLICY "recount_snap_select" ON inventory.recount_product_snapshots FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "recount_snap_insert" ON inventory.recount_product_snapshots;
CREATE POLICY "recount_snap_insert" ON inventory.recount_product_snapshots FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "recount_snap_delete" ON inventory.recount_product_snapshots;
CREATE POLICY "recount_snap_delete" ON inventory.recount_product_snapshots FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
