-- COGS Price Check (Finance). A vendor sends a back-dated price change; anything Droptop already booked at the OLD price (receipts, adjustments,
-- sales) has to be re-costed so the expected ending balance is right. This module replaces the "COGS Check (Rebate Pricing Check)" workbook:
--   * cogs_price_entries  — the correct price per quart for each vendor product, with a start and end date, so several can roll at once.
--   * cogs_checks         — a saved check: vendor + window (+ Valvoline-style "sell through the starting on hand first").
--   * cogs_ledger         — Droptop's inventory change detail (sale / receipt / adjustment, with the cost it booked), uploaded from the Power BI export.
--   * cogs_start_balances — starting on hand per shop + product (Valvoline: sales draw this down before any re-costing starts).

CREATE TABLE IF NOT EXISTS inventory.cogs_price_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  vendor       text NOT NULL,                 -- 'RelaDyne', 'Valvoline', ...
  product_id   text NOT NULL,                 -- the product id Droptop uses (itemId)
  price_per_qt numeric(12,5) NOT NULL,        -- the correct cost per quart
  start_date   date,                          -- null = from the beginning
  end_date     date,                          -- null = still in effect
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cogs_price_entries_lookup ON inventory.cogs_price_entries (company_id, vendor, product_id);

CREATE TABLE IF NOT EXISTS inventory.cogs_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL,
  name               text NOT NULL,
  vendor             text NOT NULL,
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  sell_through       boolean NOT NULL DEFAULT false,   -- sales use up the starting on hand before re-costing starts
  start_balance_date date,                             -- which starting-on-hand upload to use
  adjust_unmatched   boolean NOT NULL DEFAULT false,   -- also re-cost costs that match no listed price
  tolerance          numeric NOT NULL DEFAULT 0.005,   -- $/qt two costs may differ by and still count as the same price
  notes              text,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory.cogs_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL,
  location_id   uuid NOT NULL,
  change_date   date NOT NULL,
  change_type   text NOT NULL CHECK (change_type IN ('sale', 'receipt', 'adjustment')),
  product_id    text NOT NULL,
  po_custom_id  text NOT NULL DEFAULT '',     -- receipts: the PO's custom id (carries our order date)
  uom           text,
  qty_change    numeric NOT NULL,             -- signed: receipts +, sales -, adjustments +/-
  total_cost    numeric NOT NULL,             -- signed the same way: the cost Droptop booked
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, change_date, change_type, product_id, po_custom_id)
);
CREATE INDEX IF NOT EXISTS idx_cogs_ledger_window ON inventory.cogs_ledger (company_id, change_date);

CREATE TABLE IF NOT EXISTS inventory.cogs_start_balances (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  as_of_date  date NOT NULL,
  product_id  text NOT NULL,
  on_hand_qty numeric NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, as_of_date, location_id, product_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cogs_price_entries', 'cogs_checks', 'cogs_ledger', 'cogs_start_balances'] LOOP
    EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR SELECT USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_manage', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR ALL USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())) WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))', t || '_manage', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.%I TO authenticated', t);
  END LOOP;
END $$;
