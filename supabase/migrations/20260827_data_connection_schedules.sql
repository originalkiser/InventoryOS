-- Per-connection schedule config, editable entirely from the app. The
-- pg_cron job itself (set up separately, see the companion setup notes sent
-- alongside this migration) is a single fixed-cadence dispatcher that never
-- needs to change — only these rows do, whenever someone wants to turn a
-- connection's automation on/off or change its frequency/time. That's the
-- whole point: no more editing cron schedules on the Supabase side to
-- change when/how often something runs.
CREATE TABLE IF NOT EXISTS inventory.data_connection_schedules (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid        NOT NULL,
  connection_key   text        NOT NULL,   -- 'skybitz_tanks' | 'droptop_on_hand' | 'droptop_usage'
  enabled          boolean     NOT NULL DEFAULT false,
  schedule_mode    text        NOT NULL DEFAULT 'interval' CHECK (schedule_mode IN ('interval', 'daily_utc')),
  interval_minutes integer,    -- used when schedule_mode = 'interval'
  daily_time_utc   text,       -- 'HH:MM' in UTC — used when schedule_mode = 'daily_utc'
  last_run_at      timestamptz,
  last_run_status  text,
  last_run_message text,
  next_run_at      timestamptz,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, connection_key)
);

ALTER TABLE inventory.data_connection_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dc_schedules_select" ON inventory.data_connection_schedules;
CREATE POLICY "dc_schedules_select" ON inventory.data_connection_schedules FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "dc_schedules_manage" ON inventory.data_connection_schedules;
CREATE POLICY "dc_schedules_manage" ON inventory.data_connection_schedules FOR ALL
  USING (
    company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('developer', 'administrator', 'admin')
  )
  WITH CHECK (
    company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('developer', 'administrator', 'admin')
  );

-- Seed one disabled-by-default row per known connection so the config page
-- has something to show immediately — nothing auto-runs until a schedule is
-- explicitly enabled here.
INSERT INTO inventory.data_connection_schedules (company_id, connection_key, schedule_mode, interval_minutes)
SELECT DISTINCT l.company_id, v.connection_key, 'interval', v.default_minutes
FROM core.locations l, (VALUES
  ('skybitz_tanks',   240),   -- every 4 hours
  ('droptop_on_hand', 1440),  -- once a day
  ('droptop_usage',   1440)   -- once a day
) AS v(connection_key, default_minutes)
ON CONFLICT (company_id, connection_key) DO NOTHING;
