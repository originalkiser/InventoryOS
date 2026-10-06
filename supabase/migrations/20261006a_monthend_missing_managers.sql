-- Month End Recap: the list of shops that had no shop manager during a count period (uploaded on the Recap tab). Drives the
-- call-outs for shops without a manager that hadn't submitted by end of day Monday and shops that needed a recount without one.
CREATE TABLE IF NOT EXISTS inventory.monthend_missing_managers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  count_month date NOT NULL,            -- first day of the count period's month, same as inventory.counts.count_month
  location_id uuid NOT NULL,
  shop_label  text,                     -- display label at upload time
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, count_month, location_id)
);
CREATE INDEX IF NOT EXISTS idx_monthend_missing_managers_period ON inventory.monthend_missing_managers (company_id, count_month);

ALTER TABLE inventory.monthend_missing_managers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "monthend_missing_managers_select" ON inventory.monthend_missing_managers;
CREATE POLICY "monthend_missing_managers_select" ON inventory.monthend_missing_managers FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "monthend_missing_managers_manage" ON inventory.monthend_missing_managers;
CREATE POLICY "monthend_missing_managers_manage" ON inventory.monthend_missing_managers FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.monthend_missing_managers TO authenticated;
NOTIFY pgrst, 'reload schema';
