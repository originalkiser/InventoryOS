-- Phase 3: profiles_admin_all (ALL, admin) and profiles_own_select
-- (SELECT, own row) are genuinely different conditions. Split admin off
-- SELECT (merged into one SELECT policy: own row OR admin), kept for
-- INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS "profiles_admin_all" ON outlier.user_profiles;
DROP POLICY IF EXISTS "profiles_own_select" ON outlier.user_profiles;
CREATE POLICY "profiles_insert" ON outlier.user_profiles
  FOR INSERT WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "profiles_update" ON outlier.user_profiles
  FOR UPDATE USING (outlier_current_user_role() = 'admin'::text) WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "profiles_delete" ON outlier.user_profiles
  FOR DELETE USING (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "profiles_select" ON outlier.user_profiles
  FOR SELECT USING (
    (auth_user_id = (select auth.uid()))
    OR (outlier_current_user_role() = 'admin'::text)
  );
