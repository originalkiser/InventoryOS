-- Phase 3: "Users can view own profile" (id=me) and "Users can view
-- teammates" (company match) are 2 distinct SELECT policies with
-- genuinely different conditions (id=me is provably a special case of
-- company match only via a fragile algebraic identity through
-- get_my_company_id() — not relied on here). Merged via OR instead,
-- which needs no such assumption.
DROP POLICY IF EXISTS "Users can view own profile" ON platform.user_profiles;
DROP POLICY IF EXISTS "Users can view teammates" ON platform.user_profiles;
CREATE POLICY "Users can view own profile or teammates" ON platform.user_profiles
  FOR SELECT USING (
    (id = (select auth.uid()))
    OR (company_id = get_my_company_id())
  );
