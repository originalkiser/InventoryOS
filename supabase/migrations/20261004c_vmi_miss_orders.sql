-- "Possible VMI misses" orders: a RelaDyne order type created from an Inventory Alert for shops whose VMI/keep-fill tank
-- will run dry but no bulk order is in the system within the distributor's usual window. One such order per day per
-- company (two people clicking the alert land on the same order), with its own export template that starts as the
-- vendor's regular one until it is customized and saved.
ALTER TABLE inventory.ov2_order_drafts
  ADD COLUMN IF NOT EXISTS order_kind text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_ov2_drafts_kind_day
  ON inventory.ov2_order_drafts (company_id, order_kind, order_date)
  WHERE order_kind <> '' AND deleted_at IS NULL AND status <> 'cancelled';

ALTER TABLE inventory.ov2_export_templates
  ADD COLUMN IF NOT EXISTS order_kind text NOT NULL DEFAULT '';
ALTER TABLE inventory.ov2_export_templates
  DROP CONSTRAINT IF EXISTS ov2_export_templates_company_id_vendor_id_is_adhoc_key;
ALTER TABLE inventory.ov2_export_templates
  ADD CONSTRAINT ov2_export_templates_company_vendor_adhoc_kind_key UNIQUE (company_id, vendor_id, is_adhoc, order_kind);
