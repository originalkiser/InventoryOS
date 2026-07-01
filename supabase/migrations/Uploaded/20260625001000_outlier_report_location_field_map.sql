-- Allow each outlier report to declare which location metadata fields supply
-- the Area Manager and Regional Director names during auto-enrichment.
-- Defaults match the existing lookup priority (area_manager / regional_director).

ALTER TABLE outlier.reports
  ADD COLUMN IF NOT EXISTS am_location_field  text DEFAULT 'area_manager',
  ADD COLUMN IF NOT EXISTS rdo_location_field text DEFAULT 'regional_director';
