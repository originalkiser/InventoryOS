-- Add soft-delete support to tasks, issues, and projects.
-- Rows with deleted_at IS NOT NULL are treated as deleted; the app
-- filters them out of normal queries and purges them after 30 days.

ALTER TABLE tasks    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE issues   ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
