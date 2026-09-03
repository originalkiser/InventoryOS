-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage recount_config" ON inventory.recount_config;
CREATE POLICY "Admins can insert recount_config" ON inventory.recount_config
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update recount_config" ON inventory.recount_config
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete recount_config" ON inventory.recount_config
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
