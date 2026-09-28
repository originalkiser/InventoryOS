-- Ad Hoc orders can have their own independently-customizable export format
-- (2026-09-28 ask), distinct from the vendor's regular scheduled-order
-- default. inventory.ov2_export_templates was one row per (company_id,
-- vendor_id) — widened with an `is_adhoc` dimension so both variants can
-- coexist as separate rows under the same vendor. OrdersV2Export.tsx falls
-- back to the vendor's regular (is_adhoc = false) row when no ad-hoc-specific
-- row has been saved yet, so an ad hoc export starts out identical to the
-- vendor default until explicitly customized and saved.
ALTER TABLE inventory.ov2_export_templates
  ADD COLUMN IF NOT EXISTS is_adhoc boolean NOT NULL DEFAULT false;

ALTER TABLE inventory.ov2_export_templates
  DROP CONSTRAINT IF EXISTS ov2_export_templates_company_id_vendor_id_key;

ALTER TABLE inventory.ov2_export_templates
  ADD CONSTRAINT ov2_export_templates_company_id_vendor_id_is_adhoc_key
  UNIQUE (company_id, vendor_id, is_adhoc);
