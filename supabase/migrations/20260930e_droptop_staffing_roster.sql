-- Staffing List — a real employee -> Manager/Hourly roster, to replace
-- the wage-threshold proxy in Staffing Report's Forecast comparison for
-- anyone on it (Droptop's time clock data has no role/title field at all
-- — see droptop_time_clock_sync_state's own migration comment — so the
-- wage threshold was always a stand-in, not real data). Keyed by
-- droptop_user_id (Droptop's own stable user id), NOT name — names alone
-- can collide across ~250 shops' worth of staff. first_name/last_name are
-- carried for display only (whatever they were at the time the roster row
-- was last saved), not used for matching.
CREATE TABLE IF NOT EXISTS inventory.droptop_staffing_roster (
  company_id      uuid        NOT NULL,
  droptop_user_id text        NOT NULL,
  first_name      text,
  last_name       text,
  role            text        NOT NULL CHECK (role IN ('manager', 'hourly')),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, droptop_user_id)
);

ALTER TABLE inventory.droptop_staffing_roster ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_staffing_roster_select" ON inventory.droptop_staffing_roster;
CREATE POLICY "droptop_staffing_roster_select" ON inventory.droptop_staffing_roster FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "droptop_staffing_roster_manage" ON inventory.droptop_staffing_roster;
CREATE POLICY "droptop_staffing_roster_manage" ON inventory.droptop_staffing_roster FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Every distinct employee ever clocked in, with their most recent known
-- name — used to resolve a Staffing List upload's "Employee Name" column
-- to a real droptop_user_id (the upload has no user id, only a name).
-- DISTINCT ON keeps this to one row per employee regardless of how many
-- punches they have. SECURITY INVOKER, same reasoning as the other
-- read-only RPCs here — the caller's own RLS on droptop_time_records
-- applies, no company_id argument needed or trusted.
CREATE OR REPLACE FUNCTION public.get_droptop_time_clock_employees()
RETURNS TABLE (droptop_user_id text, first_name text, last_name text)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT DISTINCT ON (t.droptop_user_id) t.droptop_user_id, t.first_name, t.last_name
  FROM inventory.droptop_time_records t
  ORDER BY t.droptop_user_id, t.clock_in DESC
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_time_clock_employees() TO authenticated;
