-- Exception Reporting — inventory-specific finding log (separate from platform.issues).
-- Backs the Inventory → Exception Reporting page and the Location Lookup box; both
-- read/write the same table so entries stay in sync across surfaces.
-- Safe to re-run: IF NOT EXISTS everywhere.

-- ===========================================================================
-- 1. Exception reports (maps to the tracking spreadsheet)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.exception_reports (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL,
  location_id         uuid,
  area_manager        text,
  date_of_finding     date,
  date_of_shop_action date,
  report_type         text,       -- 'PO Match' | 'Activity' | 'Current On Hand'
  issue               text,       -- dynamic per report_type
  details             text,
  contacted           boolean     NOT NULL DEFAULT false,
  contacted_date      date,
  response            text,
  rd_if_no            text,       -- RelaDyne escalation note when shop didn't respond
  response_notes      text,
  status              text,       -- pending shop/am | pending reladyne | pending procurement | tentatively closed | closed
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_exc_reports_company
  ON inventory.exception_reports (company_id, location_id);

ALTER TABLE inventory.exception_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exc_reports_select" ON inventory.exception_reports;
CREATE POLICY "exc_reports_select" ON inventory.exception_reports FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "exc_reports_insert" ON inventory.exception_reports;
CREATE POLICY "exc_reports_insert" ON inventory.exception_reports FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "exc_reports_update" ON inventory.exception_reports;
CREATE POLICY "exc_reports_update" ON inventory.exception_reports FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "exc_reports_delete" ON inventory.exception_reports;
CREATE POLICY "exc_reports_delete" ON inventory.exception_reports FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- ===========================================================================
-- 2. Custom "ER Issue" options added via "add to list" (defaults live in app code)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inventory.exception_issue_option (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  report_type text        NOT NULL,
  value       text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, report_type, value)
);
CREATE INDEX IF NOT EXISTS idx_inv_exc_issue_opt_company
  ON inventory.exception_issue_option (company_id, report_type);

ALTER TABLE inventory.exception_issue_option ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "exc_issue_opt_select" ON inventory.exception_issue_option;
CREATE POLICY "exc_issue_opt_select" ON inventory.exception_issue_option FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "exc_issue_opt_insert" ON inventory.exception_issue_option;
CREATE POLICY "exc_issue_opt_insert" ON inventory.exception_issue_option FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "exc_issue_opt_delete" ON inventory.exception_issue_option;
CREATE POLICY "exc_issue_opt_delete" ON inventory.exception_issue_option FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
