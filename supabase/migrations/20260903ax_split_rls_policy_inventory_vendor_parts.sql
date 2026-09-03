-- Phase 3: same pattern — admin ALL policy split off SELECT.
DROP POLICY IF EXISTS "Admins can manage vendor_parts" ON inventory.vendor_parts;
CREATE POLICY "Admins can insert vendor_parts" ON inventory.vendor_parts
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update vendor_parts" ON inventory.vendor_parts
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete vendor_parts" ON inventory.vendor_parts
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
