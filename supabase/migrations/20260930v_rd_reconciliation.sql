-- RelaDyne Open Sales Order / Open Invoice reconciliation (2026-09-16
-- request) — RelaDyne doesn't expose these two reports via an API, so
-- they're uploaded by hand as Excel exports and snapshotted here. Both
-- reports represent "as of right now" state (which orders are still open,
-- which invoices are still outstanding), not an append-only ledger, so
-- each new upload REPLACES the company's prior snapshot for that report
-- type entirely (see OrdersV2Reconciliation.tsx's upload handler) rather
-- than accumulating history — "last updated" is just MAX(uploaded_at)
-- over the current snapshot, no separate tracking table needed.
--
-- customer_po_no is the join key back to our own placed orders — it's the
-- exact same string as ov2_order_history_lines' own po_number (see
-- engine.ts's poNumber(), '{shop}-{MMDDYYYY}{B|P}') whenever the order
-- originated from Orders v2, confirmed against real production data.
CREATE TABLE IF NOT EXISTS inventory.rd_open_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid REFERENCES core.locations(id),
  sales_order_no text,
  customer_po_no text,
  order_date date,
  order_type text,
  warehouse_code text,
  ship_to_code text,
  ship_to_name text,
  product_code text,
  product_desc text,
  qty_ordered numeric,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid
);
CREATE INDEX IF NOT EXISTS rd_open_orders_po_idx ON inventory.rd_open_orders (company_id, customer_po_no);
CREATE INDEX IF NOT EXISTS rd_open_orders_so_idx ON inventory.rd_open_orders (company_id, sales_order_no);

CREATE TABLE IF NOT EXISTS inventory.rd_open_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid REFERENCES core.locations(id),
  sales_order_no text,
  customer_po_no text,
  invoice_no text,
  order_date date,
  ship_date date,
  invoice_date date,
  invoice_due_date date,
  ship_to_code text,
  ship_to_name text,
  product_code text,
  product_desc text,
  qty_ordered numeric,
  qty_shipped numeric,
  gallons_ordered numeric,
  gallons_shipped numeric,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid
);
CREATE INDEX IF NOT EXISTS rd_open_invoices_po_idx ON inventory.rd_open_invoices (company_id, customer_po_no);
CREATE INDEX IF NOT EXISTS rd_open_invoices_so_idx ON inventory.rd_open_invoices (company_id, sales_order_no);

ALTER TABLE inventory.rd_open_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.rd_open_invoices ENABLE ROW LEVEL SECURITY;

-- Same shape as inventory.product_usage ("Company members manage") rather
-- than an admin-gated config table — uploading these reports is a
-- day-to-day procurement task, not an admin-only setting, and whoever
-- currently uploads them into the offline spreadsheet template today isn't
-- necessarily an app admin.
CREATE POLICY "Company members manage rd_open_orders" ON inventory.rd_open_orders
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
CREATE POLICY "Company members manage rd_open_invoices" ON inventory.rd_open_invoices
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());
