-- Phase 3: outlier.departments and outlier.reports each have an
-- unconditionally-true SELECT policy scoped to role `authenticated`
-- (auth_sel_departments / auth_sel_reports) that already grants every
-- authenticated session full read access — that makes the other SELECT
-- policy on each table (auth.uid() IS NOT NULL — false for anon anyway)
-- fully redundant, and makes the admin ALL policy's SELECT reach
-- redundant too (admin implies authenticated). Dropped the redundant
-- SELECT policies and split each admin ALL policy down to
-- INSERT/UPDATE/DELETE, where nothing else covers it.
DROP POLICY IF EXISTS "departments_all_read" ON outlier.departments;
DROP POLICY IF EXISTS "departments_admin_write" ON outlier.departments;
CREATE POLICY "departments_admin_insert" ON outlier.departments
  FOR INSERT WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "departments_admin_update" ON outlier.departments
  FOR UPDATE USING (outlier_current_user_role() = 'admin'::text) WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "departments_admin_delete" ON outlier.departments
  FOR DELETE USING (outlier_current_user_role() = 'admin'::text);

DROP POLICY IF EXISTS "reports_all_read" ON outlier.reports;
DROP POLICY IF EXISTS "reports_admin_write" ON outlier.reports;
CREATE POLICY "reports_admin_insert" ON outlier.reports
  FOR INSERT WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "reports_admin_update" ON outlier.reports
  FOR UPDATE USING (outlier_current_user_role() = 'admin'::text) WITH CHECK (outlier_current_user_role() = 'admin'::text);
CREATE POLICY "reports_admin_delete" ON outlier.reports
  FOR DELETE USING (outlier_current_user_role() = 'admin'::text);
