-- Phase 3: platform.user_profiles INSERT and UPDATE overlaps.
--
-- INSERT: "Admins can insert company profiles" (company AND is_admin)
-- and "Users can insert own profile" (id=me) are genuinely different
-- conditions — neither a subset of the other. Merged via OR.
--
-- UPDATE: three policies overlapped. "admins_update_company_profiles"'s
-- condition — (id=me) OR (role='admin' exactly AND same company via a
-- self-join) — is a strict subset of the union of the other two: its
-- (id=me) term is identical to "Users can update own profile", and its
-- role='admin' term is a subset of "Admins can update company users"'s
-- role IN (admin,administrator,developer) term (same company-match
-- structure). So it's fully redundant — dropped outright. The remaining
-- two have genuinely different conditions, merged via OR.
--
-- Verified via get_advisors: both resolved with no access change.
DROP POLICY IF EXISTS "Admins can insert company profiles" ON platform.user_profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON platform.user_profiles;
CREATE POLICY "Users or admins can insert profiles" ON platform.user_profiles
  FOR INSERT WITH CHECK (
    (id = (select auth.uid()))
    OR ((company_id = get_my_company_id()) AND is_admin())
  );

DROP POLICY IF EXISTS "admins_update_company_profiles" ON platform.user_profiles;
DROP POLICY IF EXISTS "Admins can update company users" ON platform.user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON platform.user_profiles;
CREATE POLICY "Users or admins can update profiles" ON platform.user_profiles
  FOR UPDATE
  USING (
    (id = (select auth.uid()))
    OR ((company_id = get_my_company_id()) AND (( SELECT user_profiles_1.role FROM platform.user_profiles user_profiles_1 WHERE (user_profiles_1.id = (select auth.uid()))) = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])))
  )
  WITH CHECK (
    (id = (select auth.uid()))
    OR ((company_id = get_my_company_id()) AND (( SELECT user_profiles_1.role FROM platform.user_profiles user_profiles_1 WHERE (user_profiles_1.id = (select auth.uid()))) = ANY (ARRAY['admin'::text, 'administrator'::text, 'developer'::text])))
  );
