-- Phase 3: "Admins can manage data_source_links" (ALL, company AND
-- is_admin) is a strict subset of "Company members can read
-- data_source_links" (SELECT, company only) for SELECT specifically —
-- admin already gets in via the broader read policy. But it's the sole
-- grant for INSERT/UPDATE/DELETE, so split rather than drop: same
-- condition, just narrowed off SELECT. Same access, fewer evaluations.
DROP POLICY IF EXISTS "Admins can manage data_source_links" ON inventory.data_source_links;
CREATE POLICY "Admins can insert data_source_links" ON inventory.data_source_links
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update data_source_links" ON inventory.data_source_links
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete data_source_links" ON inventory.data_source_links
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
