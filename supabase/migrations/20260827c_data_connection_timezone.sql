-- Follow-up to 20260827_data_connection_schedules.sql: daily schedules were
-- originally UTC-only (schedule_mode 'daily_utc', column daily_time_utc).
-- This switches them to the company's own timezone (platform.app_settings
-- key 'data_connection_timezone', defaulting to America/Chicago in the app
-- when unset) instead of requiring a manual UTC conversion.
--
-- Safe to run whether or not 20260827_data_connection_schedules.sql had
-- already been applied under its old UTC-only column/value names — each
-- step only acts if the old shape is actually present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'inventory' AND table_name = 'data_connection_schedules' AND column_name = 'daily_time_utc'
  ) THEN
    ALTER TABLE inventory.data_connection_schedules RENAME COLUMN daily_time_utc TO daily_time;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inventory.data_connection_schedules WHERE schedule_mode = 'daily_utc'
  ) THEN
    UPDATE inventory.data_connection_schedules SET schedule_mode = 'daily' WHERE schedule_mode = 'daily_utc';
  END IF;
END $$;

-- Re-point the check constraint at the new value, if it's still the old one.
ALTER TABLE inventory.data_connection_schedules DROP CONSTRAINT IF EXISTS data_connection_schedules_schedule_mode_check;
ALTER TABLE inventory.data_connection_schedules ADD CONSTRAINT data_connection_schedules_schedule_mode_check
  CHECK (schedule_mode IN ('interval', 'daily'));
