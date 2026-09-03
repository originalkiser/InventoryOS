-- Phase 3: admin_dev_manage_connections (ALL, role in dev/administrator,
-- no company check) is a subset of authenticated_read_connections
-- (SELECT, any authenticated user) for SELECT. Split off SELECT.
DROP POLICY IF EXISTS "admin_dev_manage_connections" ON platform.data_connections;
CREATE POLICY "admin_dev_insert_connections" ON platform.data_connections
  FOR INSERT WITH CHECK (
    ( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text])
  );
CREATE POLICY "admin_dev_update_connections" ON platform.data_connections
  FOR UPDATE
  USING (
    ( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text])
  )
  WITH CHECK (
    ( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text])
  );
CREATE POLICY "admin_dev_delete_connections" ON platform.data_connections
  FOR DELETE
  USING (
    ( SELECT user_profiles.role FROM platform.user_profiles WHERE (user_profiles.id = (select auth.uid()))) = ANY (ARRAY['developer'::text, 'administrator'::text])
  );
