-- Phase 3: admin_dev_manage_location_data_source (ALL, role IN dev/admin
-- AND company match) is a subset of company_read_location_data_source
-- (SELECT, any authenticated user AND company match) for SELECT — role
-- IN(dev,admin) implies authenticated=true. Split off SELECT, kept for
-- INSERT/UPDATE/DELETE where nothing else covers it.
DROP POLICY IF EXISTS "admin_dev_manage_location_data_source" ON core.location_data_source;
CREATE POLICY "admin_dev_insert_location_data_source" ON core.location_data_source
  FOR INSERT WITH CHECK (
    (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text]))
    AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))
  );
CREATE POLICY "admin_dev_update_location_data_source" ON core.location_data_source
  FOR UPDATE
  USING (
    (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text]))
    AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))
  )
  WITH CHECK (
    (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text]))
    AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))
  );
CREATE POLICY "admin_dev_delete_location_data_source" ON core.location_data_source
  FOR DELETE
  USING (
    (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text]))
    AND ((company_id IS NULL) OR (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid())))))
  );
