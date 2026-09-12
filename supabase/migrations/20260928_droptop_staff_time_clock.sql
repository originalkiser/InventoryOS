-- Droptop Staff Time Clock — new data connection pulling clock-in/clock-out
-- records per location, to compare against car counts (Droptop orders) and
-- order timing. Get Staff Time Clock has no record id of its own in its
-- response shape, so the natural key here is (company_id, location_id,
-- droptop_user_id, clock_in) — a person can't have two distinct time
-- records with the exact same clock-in instant at the same shop. `raw`
-- keeps the full source record (including the audit_log Droptop returns)
-- for anything not modeled as its own column, matching this app's
-- preserve-the-source-payload convention elsewhere (raw_monday_data, etc).
CREATE TABLE IF NOT EXISTS inventory.droptop_time_records (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  droptop_user_id    text        NOT NULL,
  first_name         text,
  last_name          text,
  email              text,
  phone_number       text,
  clock_in           timestamptz NOT NULL,
  clock_out          timestamptz,
  hours              numeric,
  hours_regular      numeric,
  hours_overtime     numeric,
  hourly_wage        numeric,
  overtime_pay_rate  numeric,
  work_week_start    text,
  work_week_end      text,
  hours_per_week     numeric,
  raw                jsonb,
  last_change_source text        NOT NULL DEFAULT 'droptop',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, droptop_user_id, clock_in)
);
CREATE INDEX IF NOT EXISTS idx_inv_droptop_time_records_location_date ON inventory.droptop_time_records (company_id, location_id, clock_in);

ALTER TABLE inventory.droptop_time_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_time_records_select" ON inventory.droptop_time_records;
CREATE POLICY "droptop_time_records_select" ON inventory.droptop_time_records FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only.
