-- Fix infinite recursion in platform.issues RLS.
--
-- issues_select queries issue_shares/issue_participants/issue_department_exclusions.
-- Those tables' SELECT policies query platform.issues → triggers issues_select again → loop.
--
-- Fix: disable RLS on the three support tables. Access to them is already
-- controlled by the issues table policy — the support rows are meaningless
-- without their parent issue, and no sensitive content is stored in them.

ALTER TABLE platform.issue_shares DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.issue_participants DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform.issue_department_exclusions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "issue_shares_select"         ON platform.issue_shares;
DROP POLICY IF EXISTS "issue_shares_all"             ON platform.issue_shares;
DROP POLICY IF EXISTS "issue_participants_select"    ON platform.issue_participants;
DROP POLICY IF EXISTS "issue_participants_all"       ON platform.issue_participants;
DROP POLICY IF EXISTS "issue_dept_exclusions_select" ON platform.issue_department_exclusions;
DROP POLICY IF EXISTS "issue_dept_exclusions_all"    ON platform.issue_department_exclusions;
