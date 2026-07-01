-- Schedule event time fields
-- Apply AFTER 20260628_eod_holidays.sql
-- Run in Supabase SQL Editor

ALTER TABLE platform.schedule_events
  ADD COLUMN IF NOT EXISTS start_time       text,
  ADD COLUMN IF NOT EXISTS end_time         text,
  ADD COLUMN IF NOT EXISTS is_all_day       boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_minutes integer;
