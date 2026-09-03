-- Phase 3: dept_admin_all (ALL, admin/developer role AND same company) is
-- a subset of dept_company_member_select (SELECT, any company member)
-- for SELECT. Split off SELECT.
DROP POLICY IF EXISTS "dept_admin_all" ON platform.departments;
CREATE POLICY "dept_admin_insert" ON platform.departments
  FOR INSERT WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = departments.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
CREATE POLICY "dept_admin_update" ON platform.departments
  FOR UPDATE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = departments.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  )
  WITH CHECK (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = departments.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
CREATE POLICY "dept_admin_delete" ON platform.departments
  FOR DELETE
  USING (
    EXISTS ( SELECT 1 FROM platform.user_profiles p WHERE ((p.id = (select auth.uid())) AND (p.company_id = departments.company_id) AND (p.role = ANY (ARRAY['admin'::text, 'developer'::text])) AND (p.deleted_at IS NULL)))
  );
