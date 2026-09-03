-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins manage custom_field_definitions" ON inventory.field_definitions;
CREATE POLICY "Admins can insert custom_field_definitions" ON inventory.field_definitions
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update custom_field_definitions" ON inventory.field_definitions
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete custom_field_definitions" ON inventory.field_definitions
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
