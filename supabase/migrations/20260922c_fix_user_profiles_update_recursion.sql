-- HOTFIX: platform.user_profiles UPDATE policy recursion.
--
-- "Users or admins can update profiles" had an inline sub-SELECT on
-- user_profiles itself:
--   (SELECT role FROM platform.user_profiles WHERE id = auth.uid())
-- Postgres 17 rejects that as "infinite recursion detected in policy for
-- relation user_profiles" the moment an admin edits ANOTHER user (editing
-- your own row short-circuits on id = auth.uid() and never runs it), which
-- broke the admin Manage User modal (e.g. granting a department user a
-- section). Swap it for is_admin() — the STABLE SECURITY DEFINER helper
-- that already backs the INSERT policy — so nothing self-references.
-- Behaviour is unchanged: admin / administrator / developer in the same
-- company can update a user; nobody else can update anyone but themselves.

ALTER POLICY "Users or admins can update profiles" ON platform.user_profiles
  USING (
    (id = (SELECT auth.uid()))
    OR ((company_id = get_my_company_id()) AND is_admin())
  )
  WITH CHECK (
    (id = (SELECT auth.uid()))
    OR ((company_id = get_my_company_id()) AND is_admin())
  );
