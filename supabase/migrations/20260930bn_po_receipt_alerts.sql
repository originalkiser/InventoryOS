-- New feature 2026-09-25: "Late PO Receipt Alerts" — for a purchase order
-- from an enabled supplier (RelaDyne to start), flag it when it's had NO
-- receipt activity at all N days past its expected delivery date. Lives as
-- its own tab on the Exception Reporting page, gated behind a settings
-- toggle (exception_config.poAlertsEnabled) plus a per-supplier toggle
-- (poAlertSuppliers), both added to ExceptionConfig client-side.
--
-- Deliberately its OWN table, not a new inventory.exception_reports row
-- type — confirmed via useNavBadges.ts that the sidebar's exception-report
-- badge count reads that table directly with no source/report_type filter,
-- so a separate table is the only way to satisfy "do not add the count to
-- the sidebar for now" without also touching that badge query (and the
-- Reports/Alerts tabs, which don't filter by source either — a new
-- exception_reports row would show up there too, unwanted).
--
-- Computed client-side (droptop_purchase_orders/_items are SELECT-only for
-- authenticated users — no server-side job can write here), triggered by a
-- "Check Now" button on the new tab. Upsert-by-key, insert-only: an existing
-- alert row is NEVER touched by a later recompute (status/notes are fully
-- user-owned once created) — same "never reopen/never overwrite a manual
-- decision" principle as the RD Reconciliation feature
-- (rdReconciliation.ts), but stricter: that feature still overwrote
-- status/date on every re-run for a non-closed finding, which its own
-- session notes flag as a real gap — not repeated here.
CREATE TABLE IF NOT EXISTS inventory.po_receipt_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid,
  po_id text NOT NULL,
  custom_po_id text,
  supplier_name text,
  po_created_at timestamptz,
  expected_delivery_date date,
  days_late integer,
  status text NOT NULL DEFAULT 'Pending Shop/AM Response',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  last_change_source text,
  UNIQUE (company_id, location_id, po_id)
);

ALTER TABLE inventory.po_receipt_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_receipt_alerts_select ON inventory.po_receipt_alerts
  FOR SELECT USING (company_id = public.get_my_company_id());
CREATE POLICY po_receipt_alerts_insert ON inventory.po_receipt_alerts
  FOR INSERT WITH CHECK (company_id = public.get_my_company_id());
CREATE POLICY po_receipt_alerts_update ON inventory.po_receipt_alerts
  FOR UPDATE USING (company_id = public.get_my_company_id());
CREATE POLICY po_receipt_alerts_delete ON inventory.po_receipt_alerts
  FOR DELETE USING (company_id = public.get_my_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.po_receipt_alerts TO authenticated;

-- Backs the Settings tab's per-supplier toggle list — real distinct
-- supplier_name values seen on this company's own POs (not a hardcoded
-- list, which would go stale the same way this doc's own schema-location
-- claims have repeatedly turned out to). Same shape/precedent as
-- get_droptop_package_name_counts().
CREATE OR REPLACE FUNCTION public.get_droptop_po_supplier_names(p_company_id uuid)
RETURNS TABLE (supplier_name text, cnt bigint)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT po.supplier_name, count(*)
  FROM inventory.droptop_purchase_orders po
  WHERE po.company_id = p_company_id AND po.supplier_name IS NOT NULL
  GROUP BY po.supplier_name
  ORDER BY count(*) DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_po_supplier_names TO authenticated;
