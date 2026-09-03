-- Phase 3: am_locations_admin_all (ALL, admin) and am_locations_own_select
-- (SELECT, own row) are genuinely different conditions. Split admin off
-- SELECT (merged into one SELECT policy: own row OR admin), kept for
-- INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "am_locations_admin_all" ON outlier.am_locations;
DROP POLICY IF EXISTS "am_locations_own_select" ON outlier.am_locations;
CREATE POLICY "am_locations_insert" ON outlier.am_locations
  FOR INSERT WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "am_locations_update" ON outlier.am_locations
  FOR UPDATE USING (outlier_current_user_role() = 'admin'::text) WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "am_locations_delete" ON outlier.am_locations
  FOR DELETE USING (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "am_locations_select" ON outlier.am_locations
  FOR SELECT USING (
    (user_id = outlier_current_user_profile_id())
    OR (outlier_current_user_role() = 'admin'::text)
  );
