-- Add user-assignment columns to outlier.report_entries so AM/RDO cells
-- can be overridden to any app user and that user sees the entry as an
-- assigned task in their AM Dashboard.
ALTER TABLE outlier.report_entries
  ADD COLUMN IF NOT EXISTS am_assigned_user_id  uuid,
  ADD COLUMN IF NOT EXISTS rdo_assigned_user_id uuid;
