-- Add free-text assignee name to tasks (for non-org assignees).
-- When an org user is selected, assignee_id is set and assignee_name is null.
-- When free text is typed, assignee_id is null and assignee_name holds the name.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_name text;

-- Add assignee text field to issues (free text or org member name).
ALTER TABLE issues ADD COLUMN IF NOT EXISTS assignee text;
