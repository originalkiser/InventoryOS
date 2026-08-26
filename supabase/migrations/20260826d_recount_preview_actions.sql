-- Per-period workflow state for the Recount Logic live preview: hiding a
-- specific product from a shop's recount consideration, excluding a whole
-- shop from this period's recount pass, or setting a shop aside to revisit
-- later ("Flagged for Later"). One table covers all three via a nullable
-- product_id (null = applies to the whole shop) and an action type.
CREATE TABLE IF NOT EXISTS inventory.recount_preview_actions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  count_month  date        NOT NULL,
  location_id  uuid        NOT NULL,
  product_id   text,        -- null = applies to the whole shop
  action       text        NOT NULL CHECK (action IN ('hidden_product', 'excluded_shop', 'flagged_later')),
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, count_month, location_id, product_id, action)
);
CREATE INDEX IF NOT EXISTS idx_inv_recount_preview_actions_period
  ON inventory.recount_preview_actions (company_id, count_month);

ALTER TABLE inventory.recount_preview_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "recount_preview_actions_select" ON inventory.recount_preview_actions;
CREATE POLICY "recount_preview_actions_select" ON inventory.recount_preview_actions FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "recount_preview_actions_insert" ON inventory.recount_preview_actions;
CREATE POLICY "recount_preview_actions_insert" ON inventory.recount_preview_actions FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "recount_preview_actions_delete" ON inventory.recount_preview_actions;
CREATE POLICY "recount_preview_actions_delete" ON inventory.recount_preview_actions FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
