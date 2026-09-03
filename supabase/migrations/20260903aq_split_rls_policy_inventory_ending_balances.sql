-- Phase 3: same pattern as 20260903ap — admin ALL policy split off SELECT
-- (already covered by a broader company-only read policy), kept for
-- INSERT/UPDATE/DELETE since nothing else covers those.
DROP POLICY IF EXISTS "Admins can manage monthly_ending_balances" ON inventory.ending_balances;
CREATE POLICY "Admins can insert monthly_ending_balances" ON inventory.ending_balances
  FOR INSERT WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can update monthly_ending_balances" ON inventory.ending_balances
  FOR UPDATE USING ((company_id = get_my_company_id()) AND is_admin()) WITH CHECK ((company_id = get_my_company_id()) AND is_admin());
CREATE POLICY "Admins can delete monthly_ending_balances" ON inventory.ending_balances
  FOR DELETE USING ((company_id = get_my_company_id()) AND is_admin());
