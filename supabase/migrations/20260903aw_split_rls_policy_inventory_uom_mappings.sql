-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins manage uom_mappings" ON inventory.uom_mappings;
CREATE POLICY "Admins can insert uom_mappings" ON inventory.uom_mappings
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update uom_mappings" ON inventory.uom_mappings
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete uom_mappings" ON inventory.uom_mappings
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
