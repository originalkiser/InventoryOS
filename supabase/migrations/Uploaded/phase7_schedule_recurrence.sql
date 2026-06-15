-- Phase 7: recurring schedule tasks are materialized into individual rows so
-- they appear on the calendar, dashboard, and top-bar reminders. Each generated
-- occurrence shares a series_id so the whole series can be deleted together.

alter table schedule_events
  add column if not exists series_id uuid;

create index if not exists schedule_events_series_id_idx
  on schedule_events (series_id);
