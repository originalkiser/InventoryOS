-- Optional date-range (deadline window) for standalone tasks.
-- target_date = start of the window; target_date_end = the deadline. A task with
-- an end date isn't overdue until the end date passes, so low-priority tasks
-- don't need to be pushed forward each day.
ALTER TABLE core.tasks
  ADD COLUMN IF NOT EXISTS target_date_end date;
