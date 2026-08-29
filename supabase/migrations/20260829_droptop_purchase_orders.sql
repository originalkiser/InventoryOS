-- Droptop Purchase Orders pull — feeds both the new PO Status page and (a
-- later step) Orders v2's "already covered by an open PO, don't order it
-- again" exclusion. Same shape/conventions as the existing on-hand/usage
-- pull (droptop-sync-usage): resolved per-location via
-- core.locations.droptop_operation_id, raw Droptop product_id stored as-is
-- (resolved through product_id_mappings/global_products downstream, same
-- as product_usage already is — see buildGenerationInputs), full raw
-- payload preserved in raw_data for traceability.

CREATE TABLE IF NOT EXISTS inventory.droptop_purchase_orders (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                uuid        NOT NULL,
  location_id               uuid        REFERENCES core.locations(id),  -- null if the operation_id didn't match a location
  po_id                     text        NOT NULL,           -- Droptop's own po_id, e.g. "PO111"
  custom_po_id              text,
  supplier_id               text,
  supplier_name             text,
  po_status                 text,       -- draft | sent | accepted | closed | cancelled
  approved_status           text,
  delivery_status           text,
  pay_status                text,
  total_cost                numeric,
  note                      text,
  ship_to_name              text,
  last_updated_user_name    text,
  created_timestamp         timestamptz,
  closed_timestamp          timestamptz,
  last_updated_timestamp    timestamptz,
  to_receive_timestamp      timestamptz,
  raw_data                  jsonb,      -- full PO object exactly as Droptop returned it
  synced_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid,
  last_change_source        text        NOT NULL DEFAULT 'droptop',
  UNIQUE (company_id, po_id)
);
CREATE INDEX IF NOT EXISTS idx_droptop_po_location ON inventory.droptop_purchase_orders (location_id);
CREATE INDEX IF NOT EXISTS idx_droptop_po_status ON inventory.droptop_purchase_orders (company_id, po_status);
CREATE INDEX IF NOT EXISTS idx_droptop_po_created ON inventory.droptop_purchase_orders (company_id, created_timestamp DESC);

CREATE TABLE IF NOT EXISTS inventory.droptop_purchase_order_items (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id         uuid        NOT NULL REFERENCES inventory.droptop_purchase_orders(id) ON DELETE CASCADE,
  company_id                uuid        NOT NULL,
  purchase_order_item_id    text,
  purchase_order_item_type  text,       -- inventory_product | casual_item
  inventory_id              text,       -- Droptop's internal inventory id (PRD...)
  product_id                text,       -- Droptop's product_id (e.g. "OF2222") — raw, unresolved
  name                      text,       -- casual item name
  quantity                  numeric,
  unit_cost                 numeric,
  received_quantity         numeric,
  back_ordered_quantity     numeric,
  remaining_quantity        numeric,
  total_cost                numeric,
  purchase_uom              text,
  sell_uom                  text
);
CREATE INDEX IF NOT EXISTS idx_droptop_po_items_po ON inventory.droptop_purchase_order_items (purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_droptop_po_items_product ON inventory.droptop_purchase_order_items (company_id, product_id);

ALTER TABLE inventory.droptop_purchase_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_po_select" ON inventory.droptop_purchase_orders;
CREATE POLICY "droptop_po_select" ON inventory.droptop_purchase_orders FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written only by the sync edge function (service role) — no authenticated
-- write policy needed, same as data_connection_sync_log.

ALTER TABLE inventory.droptop_purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_po_items_select" ON inventory.droptop_purchase_order_items;
CREATE POLICY "droptop_po_items_select" ON inventory.droptop_purchase_order_items FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- New Data Connections entry, same seeding convention as
-- 20260827_data_connection_schedules.sql — disabled by default, nothing
-- auto-runs until explicitly turned on from the Data Connections tab.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT l.company_id, 'droptop_purchase_orders', 'interval', 240
FROM core.locations l
ON CONFLICT (company_id, connection_key) DO NOTHING;

-- Referenced by other tables' id (location_id) is not the direction here —
-- these are the referencING side, so no archive.deleted_rows trigger needed
-- per CLAUDE.md's "only tables other records reference by id" rule.
