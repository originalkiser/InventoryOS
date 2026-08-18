-- ============================================================
-- Fix: is_admin() and several inline admin-role RLS checks never
-- learned about the 'administrator' role.
--
-- src/lib/roles.ts issues the role string 'administrator' for new
-- admin users (the legacy 'admin' value only survives on older
-- accounts). is_admin() (defined in
-- 20260624001000_fix_helper_functions_and_rls.sql) and a handful of
-- inline role checks in that same migration were never updated to
-- match, so every *new* administrator fails every write gated on
-- them — most visibly core.locations INSERT/UPDATE ("Admins can
-- insert/update locations" in 0002_rls_policies.sql, which calls
-- is_admin()), surfacing as "new row violates row-level security
-- policy for table locations" on upsert.
--
-- This widens who these checks accept; it does not narrow anything,
-- so it's safe to apply without downtime or data changes.
-- ============================================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT role IN ('admin', 'administrator', 'developer') FROM platform.user_profiles WHERE id = auth.uid()
$$;

-- platform.user_profiles — admins updating other users in their company
DROP POLICY IF EXISTS "Admins can update company users" ON platform.user_profiles;
CREATE POLICY "Admins can update company users"
  ON platform.user_profiles
  FOR UPDATE
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'administrator', 'developer')
  );

-- core.user_feature_access — admins managing feature access for their company's users
DROP POLICY IF EXISTS "Admins can manage feature access" ON core.user_feature_access;
CREATE POLICY "Admins can manage feature access"
  ON core.user_feature_access
  FOR ALL
  USING (
    (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'administrator', 'developer')
    AND EXISTS (
      SELECT 1 FROM platform.user_profiles up
      WHERE up.id = core.user_feature_access.user_id
        AND up.company_id = get_my_company_id()
    )
  )
  WITH CHECK (
    (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'administrator', 'developer')
    AND EXISTS (
      SELECT 1 FROM platform.user_profiles up
      WHERE up.id = core.user_feature_access.user_id
        AND up.company_id = get_my_company_id()
    )
  );

-- outlier.paste_logs — admins correcting submitted_by_override etc.
DROP POLICY IF EXISTS "Admins can update paste_logs" ON outlier.paste_logs;
CREATE POLICY "Admins can update paste_logs"
  ON outlier.paste_logs FOR UPDATE
  USING (
    (SELECT role FROM platform.user_profiles WHERE id = auth.uid()) IN ('admin', 'administrator', 'developer')
  );
