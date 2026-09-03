-- Phase 3 final step, explicit user decision: outlier.paste_logs,
-- report_entries, and weeks each have an ALL/USING(true)/WITH CHECK(true)
-- policy for role `authenticated` that already grants unconditional
-- access to every command. Every department/admin/AM/director-scoped
-- policy on these three tables is provably inert given that grant
-- already exists — dropping them is a genuine no-op for access (they
-- contribute nothing today), not a security change. The blanket grant
-- itself is left untouched: removing it would be an actual
-- access-control decision, out of scope for this performance-only pass,
-- and was explicitly not requested.
DROP POLICY IF EXISTS "paste_logs_admin_all" ON outlier.paste_logs;
DROP POLICY IF EXISTS "Authenticated users can insert paste_logs" ON outlier.paste_logs;
DROP POLICY IF EXISTS "paste_logs_dept_write" ON outlier.paste_logs;
DROP POLICY IF EXISTS "Authenticated users can read paste_logs" ON outlier.paste_logs;
DROP POLICY IF EXISTS "paste_logs_read" ON outlier.paste_logs;
DROP POLICY IF EXISTS "Admins can update paste_logs" ON outlier.paste_logs;

DROP POLICY IF EXISTS "entries_admin_all" ON outlier.report_entries;
DROP POLICY IF EXISTS "Authenticated users can insert report_entries" ON outlier.report_entries;
DROP POLICY IF EXISTS "entries_dept_write" ON outlier.report_entries;
DROP POLICY IF EXISTS "Authenticated users can read report_entries" ON outlier.report_entries;
DROP POLICY IF EXISTS "entries_am_read" ON outlier.report_entries;
DROP POLICY IF EXISTS "entries_dept_read" ON outlier.report_entries;
DROP POLICY IF EXISTS "entries_director_read" ON outlier.report_entries;
DROP POLICY IF EXISTS "Authenticated users can update report_entries" ON outlier.report_entries;
DROP POLICY IF EXISTS "entries_dept_update" ON outlier.report_entries;

DROP POLICY IF EXISTS "Authenticated users can upsert weeks" ON outlier.weeks;
DROP POLICY IF EXISTS "weeks_dept_write" ON outlier.weeks;
DROP POLICY IF EXISTS "Authenticated users can read weeks" ON outlier.weeks;
DROP POLICY IF EXISTS "weeks_all_read" ON outlier.weeks;
DROP POLICY IF EXISTS "Admins can update weeks" ON outlier.weeks;
