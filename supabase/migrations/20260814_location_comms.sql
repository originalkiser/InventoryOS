-- Location Communications — log of contacts with shops/AMs (product requests,
-- exception reporting, misc). The exception-reporting branch links to an
-- inventory.exception_reports row so it also lands in Exception Reporting.
-- Safe to re-run: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS inventory.location_comms (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL,
  location_id         uuid,
  comm_date           date,
  contact_method      text,
  email_subject       text,
  who_contacted       text,
  comm_type           text,       -- 'Product Request' | 'Exception Reporting' | custom
  products            jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{product_id,configured,on_hand,days_of_supply,orderable,eta}]
  action_taken        text,
  exception_report_id uuid,       -- set when comm_type = Exception Reporting
  status              text,
  notes               text,
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inv_location_comms_company
  ON inventory.location_comms (company_id, location_id);

ALTER TABLE inventory.location_comms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "location_comms_select" ON inventory.location_comms;
CREATE POLICY "location_comms_select" ON inventory.location_comms FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_comms_insert" ON inventory.location_comms;
CREATE POLICY "location_comms_insert" ON inventory.location_comms FOR INSERT
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_comms_update" ON inventory.location_comms;
CREATE POLICY "location_comms_update" ON inventory.location_comms FOR UPDATE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "location_comms_delete" ON inventory.location_comms;
CREATE POLICY "location_comms_delete" ON inventory.location_comms FOR DELETE
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
