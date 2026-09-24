-- Valvoline Order Database — a permanent, accumulating record of every
-- Valvoline order line we know about (real historical exports uploaded
-- from Valvoline's own order-history report, orders placed directly with
-- Valvoline that never went through SB Net, and every order this app
-- itself finalizes for Valvoline going forward). Purpose is explicitly
-- NOT delivery-schedule inference (see ov2_location_schedules /
-- DeliverySchedulesCard.tsx for that, unchanged) — this is "what's already
-- on order," so a new order can be checked against it before generating.
--
-- Same insert-only, accumulate-don't-replace shape as
-- inventory.rd_order_ledger/rd_delivery_ledger (20260930au) — a future
-- upload of the same source file (or an overlapping one) must only ever
-- ADD rows never seen before, never overwrite or remove what's already
-- here. UNIQUE (company_id, po_number, line_number) is the natural key:
-- a PO's line items are individually numbered by Valvoline's own export
-- (its own "Line Number" column) and the same shape is used for our own
-- SB Net-originated rows (source='sbnet'), numbered 1..N per shop the same
-- way Orders v2 Export's own per-shop line_number field already is.
--
-- product_id is a best-effort resolution of Valvoline's own "Material
-- Code" down to this app's own base product code (e.g. "VRP020") via
-- vendor_parts.part_number — left null when it can't be resolved (an
-- older/discontinued Valvoline material code with no current vendor_parts
-- row), which is expected for a lot of real multi-year history; the raw
-- material_code/description are always kept regardless so nothing is lost.
--
-- Deliberately no "received"/status column yet — per direct discussion,
-- determining "still pending" vs "already received" needs the expected
-- delivery date (from the shop's own order/delivery schedule) cross-
-- referenced against Droptop's own purchase-order data once it's synced
-- for that day, which is planned as a follow-up on the Purchase Orders
-- data connection rather than something this upload feature can compute
-- on its own.
CREATE TABLE inventory.valvoline_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid,
  shop_raw text,
  ship_to_account_number text,
  po_number text NOT NULL,
  po_date date,
  delivery_date date,
  line_number integer NOT NULL,
  material_code text,
  product_id text,
  description text,
  quantity numeric,
  uom text,
  source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'sbnet')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (company_id, po_number, line_number)
);

ALTER TABLE inventory.valvoline_order_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Company members manage valvoline_order_lines" ON inventory.valvoline_order_lines
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());

CREATE INDEX idx_valvoline_order_lines_location ON inventory.valvoline_order_lines (company_id, location_id);
CREATE INDEX idx_valvoline_order_lines_po_date ON inventory.valvoline_order_lines (company_id, po_date);
CREATE INDEX idx_valvoline_order_lines_product ON inventory.valvoline_order_lines (company_id, product_id);
