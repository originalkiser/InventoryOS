-- "Should have delivered by now" workflow on the RD Reports tab (direct ask 2026-10-03). One row per PO
-- (keyed by RelaDyne's customer PO number, or "SO <sales order no>" when a line has none) recording what
-- someone decided about it:
--   ignored — hide it forever (until restored from the ignored list)
--   emailed — a PO Delivery Check-In email was logged for it; leaves the email queue
--   skipped — someone skipped past it in the email flow; stays queued, skip_count shows how often
-- No row = untouched. Statuses are per PO, not per line.
CREATE TABLE IF NOT EXISTS inventory.rd_po_check_status (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL,
  po_key          text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('ignored', 'emailed', 'skipped')),
  skip_count      integer     NOT NULL DEFAULT 0,
  location_id     uuid,
  order_date      date,
  last_action_at  timestamptz NOT NULL DEFAULT now(),
  last_action_by  uuid,
  UNIQUE (company_id, po_key)
);

ALTER TABLE inventory.rd_po_check_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rd_po_check_status_select" ON inventory.rd_po_check_status;
CREATE POLICY "rd_po_check_status_select" ON inventory.rd_po_check_status FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "rd_po_check_status_manage" ON inventory.rd_po_check_status;
CREATE POLICY "rd_po_check_status_manage" ON inventory.rd_po_check_status FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.rd_po_check_status TO authenticated;
