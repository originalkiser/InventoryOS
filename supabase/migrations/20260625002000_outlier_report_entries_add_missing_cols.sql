-- Defensively add columns that may be missing if report_entries was created
-- before the 20260624001200 migration ran (CREATE TABLE IF NOT EXISTS does not
-- add columns to an already-existing table).

ALTER TABLE outlier.report_entries
  ADD COLUMN IF NOT EXISTS am_comment              text,
  ADD COLUMN IF NOT EXISTS am_comment_updated_at   timestamptz,
  ADD COLUMN IF NOT EXISTS am_comment_updated_by   uuid,
  ADD COLUMN IF NOT EXISTS location_id             uuid,
  ADD COLUMN IF NOT EXISTS area_manager_name       text,
  ADD COLUMN IF NOT EXISTS rdo_name                text;

-- Ensure the unique constraint required for upsert exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'outlier.report_entries'::regclass
      AND contype   = 'u'
      AND conname   = 'report_entries_report_id_week_id_row_key_key'
  ) THEN
    ALTER TABLE outlier.report_entries
      ADD CONSTRAINT report_entries_report_id_week_id_row_key_key
      UNIQUE (report_id, week_id, row_key);
  END IF;
END$$;

-- Ensure the am_location_field / rdo_location_field columns exist on reports
-- (also added in 20260625001000 — safe to repeat with IF NOT EXISTS)
ALTER TABLE outlier.reports
  ADD COLUMN IF NOT EXISTS am_location_field  text DEFAULT 'area_manager',
  ADD COLUMN IF NOT EXISTS rdo_location_field text DEFAULT 'regional_director';
