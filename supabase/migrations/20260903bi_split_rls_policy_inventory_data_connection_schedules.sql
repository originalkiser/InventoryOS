-- Phase 3: dc_schedules_manage (ALL, company AND role in
-- dev/administrator/admin) is a subset of dc_schedules_select (SELECT,
-- company only) for SELECT. Split manage off SELECT.
DROP POLICY IF EXISTS "dc_schedules_manage" ON inventory.data_connection_schedules;
CREATE POLICY "dc_schedules_insert" ON inventory.data_connection_schedules
  FOR INSERT WITH CHECK (
    (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))
    AND (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text, 'admin'::text]))
  );
CREATE POLICY "dc_schedules_update" ON inventory.data_connection_schedules
  FOR UPDATE
  USING (
    (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))
    AND (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text, 'admin'::text]))
  )
  WITH CHECK (
    (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))
    AND (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text, 'admin'::text]))
  );
CREATE POLICY "dc_schedules_delete" ON inventory.data_connection_schedules
  FOR DELETE
  USING (
    (company_id = ( SELECT user_profiles.company_id FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))))
    AND (( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text, 'admin'::text]))
  );
