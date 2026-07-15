-- Per-status badge colors for the Issues tracker.
-- color holds a Badge token: navy | inky | sky | cream | red | green | orange.
-- Null = keyword-based default (resolved→green, overdue→red, etc.).

ALTER TABLE inventory.issue_statuses
  ADD COLUMN IF NOT EXISTS color text;
