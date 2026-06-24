-- Outlier report entry enrichment columns
-- AM and RDO are looked up from core.locations.metadata after push,
-- never pasted directly.

ALTER TABLE outlier.report_entries
  ADD COLUMN IF NOT EXISTS location_id   uuid REFERENCES core.locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS area_manager_name text,
  ADD COLUMN IF NOT EXISTS rdo_name          text;

-- Report definition toggles for parser behavior
ALTER TABLE outlier.reports
  ADD COLUMN IF NOT EXISTS has_shop_column     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS has_employee_column boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shop_column_label   text NOT NULL DEFAULT 'Location',
  ADD COLUMN IF NOT EXISTS employee_column_label text NOT NULL DEFAULT 'Employee';
