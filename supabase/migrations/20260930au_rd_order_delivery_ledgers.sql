-- RD Open Sales Order / Open Invoice permanent history ledgers
-- (2026-09-22 request) — separate from inventory.rd_open_orders/
-- rd_open_invoices, which stay exactly as they are (snapshot-replaced on
-- every upload) since the existing PO reconciliation check
-- (useRdReports.ts's runReconciliation, rdReconciliation.ts) depends on
-- them representing "what's open right now" — accumulating those instead
-- would make a long-closed PO look permanently open to that check.
--
-- These two new tables accumulate instead: every upload adds to them
-- rather than replacing them, so "last ordered"/"last delivered" by shop+
-- product can be computed from real history, not just whatever happened
-- to be open the last time someone uploaded.
--
-- Order ledger (Open Sales Order Report): a sales order can still be
-- edited while open (per direct request, quantities/lines can change) —
-- upserted, not insert-only, so an existing (sales_order_no, product_code)
-- row reflects the LATEST known state.
--
-- Delivery ledger (Open Invoice Report): once invoiced, per direct
-- request quantities should never change again — insert-only
-- (ON CONFLICT DO NOTHING via ignoreDuplicates in the client, matching
-- the same pattern droptop-sync-usage already uses for its own alert
-- rows). A new (sales_order_no, product_code) line is added; an
-- already-seen one is left exactly as first recorded, even if the vendor's
-- file later shows a different quantity for it.
--
-- Keyed by (company_id, sales_order_no, product_code), not sales_order_no
-- alone — each is a LINE-level row (one per product on an order), so a
-- multi-line sales order needs the product code too to identify a
-- specific line.
CREATE TABLE inventory.rd_order_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid,
  sales_order_no text NOT NULL,
  product_code text NOT NULL,
  customer_po_no text,
  order_date date,
  order_type text,
  ship_to_name text,
  product_desc text,
  qty_ordered numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sales_order_no, product_code)
);

CREATE TABLE inventory.rd_delivery_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid,
  sales_order_no text NOT NULL,
  product_code text NOT NULL,
  customer_po_no text,
  invoice_no text,
  order_date date,
  invoice_date date,
  ship_to_name text,
  product_desc text,
  qty_ordered numeric,
  qty_shipped numeric,
  gallons_ordered numeric,
  gallons_shipped numeric,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sales_order_no, product_code)
);

ALTER TABLE inventory.rd_order_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.rd_delivery_ledger ENABLE ROW LEVEL SECURITY;

-- Same single-policy-for-all-commands shape as the existing
-- rd_open_orders/rd_open_invoices tables.
CREATE POLICY "Company members manage rd_order_ledger" ON inventory.rd_order_ledger
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "Company members manage rd_delivery_ledger" ON inventory.rd_delivery_ledger
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());

CREATE INDEX idx_rd_order_ledger_location_product ON inventory.rd_order_ledger (company_id, location_id, product_code);
CREATE INDEX idx_rd_delivery_ledger_location_product ON inventory.rd_delivery_ledger (company_id, location_id, product_code);

-- "Last ordered" per shop+product — the most recent order_date on record
-- for that pair (ties broken by whichever row was updated most recently).
-- DISTINCT ON requires the leading ORDER BY columns to match its own
-- column list; company scoping happens via RLS (SECURITY INVOKER), same
-- as every other plain-SQL RPC in this app.
CREATE OR REPLACE FUNCTION public.get_rd_last_ordered_by_shop_product()
RETURNS TABLE (location_id uuid, product_code text, last_order_date date, last_qty_ordered numeric, sales_order_no text)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (location_id, product_code)
    location_id, product_code, order_date AS last_order_date, qty_ordered AS last_qty_ordered, sales_order_no
  FROM inventory.rd_order_ledger
  WHERE company_id = get_my_company_id()
  ORDER BY location_id, product_code, order_date DESC NULLS LAST, last_updated_at DESC
$$;

-- "Last delivered" per shop+product — the most recent invoice_date on
-- record, using the frozen (never-updated) quantity from when that
-- specific line was first invoiced.
CREATE OR REPLACE FUNCTION public.get_rd_last_delivered_by_shop_product()
RETURNS TABLE (location_id uuid, product_code text, last_invoice_date date, last_qty_shipped numeric, sales_order_no text)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (location_id, product_code)
    location_id, product_code, invoice_date AS last_invoice_date, qty_shipped AS last_qty_shipped, sales_order_no
  FROM inventory.rd_delivery_ledger
  WHERE company_id = get_my_company_id()
  ORDER BY location_id, product_code, invoice_date DESC NULLS LAST, first_seen_at DESC
$$;
