-- Promotes Droptop Staff Time Clock from a manual-only backfill (see
-- 20260928_droptop_staff_time_clock.sql) to a real scheduled/manual data
-- connection like every other Droptop pull, now that the initial backfill's
-- data has been reviewed. Mirrors inventory.droptop_order_sync_state
-- exactly (same one-row-per-location catch-up shape, see that table's own
-- migration comment) rather than sharing it — a different connection's
-- progress tracked in the same table would conflate two independent
-- catch-up cursors under one (company_id, location_id) key.
CREATE TABLE IF NOT EXISTS inventory.droptop_time_clock_sync_state (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL,
  location_id      uuid NOT NULL,
  last_synced_date date NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id)
);
ALTER TABLE inventory.droptop_time_clock_sync_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_time_clock_sync_state_select" ON inventory.droptop_time_clock_sync_state;
CREATE POLICY "droptop_time_clock_sync_state_select" ON inventory.droptop_time_clock_sync_state FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by the service-role Edge Function only.

-- Seed one disabled-by-default schedule row per company, same precedent as
-- every other connection (see 20260908d_monday_locations_schedule.sql) — an
-- admin turns it on from Data Connections once ready.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT company_id, 'droptop_time_clock', 'interval', 1440
FROM core.locations
ON CONFLICT (company_id, connection_key) DO NOTHING;
