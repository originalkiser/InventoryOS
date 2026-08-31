-- Data Connections status tracking gap: last_run_at/last_run_status/
-- last_run_message on inventory.data_connection_schedules are written ONLY
-- by the dispatcher (see data-connection-dispatcher/index.ts's own update
-- after each scheduled run) — a manual "Run Now" click from the Data
-- Connections tab never wrote back to this table at all, so the "Last run"
-- label only ever reflected the most recent *scheduled* run, silently
-- ignoring however many times someone had run it by hand since. Add a
-- parallel set of columns for manual runs so both can be shown/tracked
-- independently, plus who ran it.
ALTER TABLE inventory.data_connection_schedules
  ADD COLUMN IF NOT EXISTS last_manual_run_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_manual_run_status text,
  ADD COLUMN IF NOT EXISTS last_manual_run_message text,
  ADD COLUMN IF NOT EXISTS last_manual_run_by uuid;
