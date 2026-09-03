-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage vendors" ON inventory.vendors;
CREATE POLICY "Admins can insert vendors" ON inventory.vendors
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update vendors" ON inventory.vendors
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete vendors" ON inventory.vendors
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
