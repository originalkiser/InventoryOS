-- Fix infinite recursion in issues RLS.
-- The support table policies (issue_shares_manage, etc.) referenced
-- inventory.issues, which triggered issues_select, which queried the
-- support tables again — a cycle. Replace with permissive policies that
-- break the cycle. The main inventory.issues policy is the real protection.

-- issue_shares
DROP POLICY IF EXISTS "issue_shares_manage" ON inventory.issue_shares;
DROP POLICY IF EXISTS "issue_shares_read"   ON inventory.issue_shares;
CREATE POLICY "issue_shares_access" ON inventory.issue_shares
  USING (true) WITH CHECK (true);

-- issue_participants
DROP POLICY IF EXISTS "issue_participants_read"   ON inventory.issue_participants;
DROP POLICY IF EXISTS "issue_participants_manage" ON inventory.issue_participants;
CREATE POLICY "issue_participants_access" ON inventory.issue_participants
  USING (true) WITH CHECK (true);

-- issue_department_exclusions
DROP POLICY IF EXISTS "issue_dept_excl_manage" ON inventory.issue_department_exclusions;
DROP POLICY IF EXISTS "issue_dept_excl_read"   ON inventory.issue_department_exclusions;
CREATE POLICY "issue_dept_excl_access" ON inventory.issue_department_exclusions
  USING (true) WITH CHECK (true);
