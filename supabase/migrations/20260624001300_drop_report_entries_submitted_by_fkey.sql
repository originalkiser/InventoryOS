-- The submitted_by column on outlier.report_entries has a FK that blocks
-- inserts when the referenced row is unreachable (cross-schema FK or
-- mismatched ID type). Drop it — submitted_by is an audit-trail UUID only;
-- referential integrity here adds no value and breaks the paste flow.

ALTER TABLE outlier.report_entries
  DROP CONSTRAINT IF EXISTS outlier_report_entries_submitted_by_fkey;

-- Drop the same FK on paste_logs if it exists there too
ALTER TABLE outlier.paste_logs
  DROP CONSTRAINT IF EXISTS outlier_paste_logs_submitted_by_fkey;

ALTER TABLE outlier.paste_logs
  DROP CONSTRAINT IF EXISTS outlier_paste_logs_submitted_by_override_fkey;
