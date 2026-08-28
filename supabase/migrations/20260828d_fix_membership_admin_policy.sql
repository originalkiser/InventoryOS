-- Fix: platform.user_department_memberships' write policy checked
-- role IN ('admin', 'developer') — but 'admin' is the legacy role value;
-- the real modern administrator role is stored as 'administrator' (see
-- src/lib/roles.ts / CLAUDE.md's roles doc). This is the same
-- legacy-vs-current naming trap this codebase has hit before on other
-- tables, just on a role string instead of a schema/table name.
--
-- Net effect in production: only the one 'developer' account could ever
-- actually write department memberships (for anyone, including themselves —
-- RLS doesn't special-case self vs. others here). Every Administrator has
-- been silently unable to save department access changes via
-- Config -> Users, for themselves or anyone else, and would have seen the
-- Save call succeed on user_profiles/user_feature_access while this part
-- silently did nothing (no error surfaces from a RLS-filtered zero-row
-- write) — worth checking whether any administrator has tried and assumed
-- it worked.

DROP POLICY IF EXISTS "membership_admin_all" ON platform.user_department_memberships;
CREATE POLICY "membership_admin_all" ON platform.user_department_memberships
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM platform.user_profiles p
      WHERE p.id = auth.uid()
        AND p.company_id = platform.user_department_memberships.company_id
        AND p.role IN ('admin', 'administrator', 'developer')
        AND p.deleted_at IS NULL
    )
  );
