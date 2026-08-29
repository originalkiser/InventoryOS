-- Droptop's PO object includes delivery_status_updated_timestamp alongside
-- delivery_status/closed_timestamp (both already captured) — missed when
-- the table was first created. Needed for the PO Status page's "when did
-- delivery status last change" column.
ALTER TABLE inventory.droptop_purchase_orders ADD COLUMN IF NOT EXISTS delivery_status_updated_timestamp timestamptz;
