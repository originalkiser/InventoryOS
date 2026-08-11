-- Recurring checklist items, lead-time reveal, and custom event colors.
--   schedule_events.color               custom calendar color (hex); overrides the type default
--   schedule_events.checklist_lead_days hide checklist items until N days before the event (default handled in app = 5)
--   event_checklist_items.start_offset_days / end_offset_days
--     for recurring events: item date window is computed per occurrence as
--     occurrence_date + offset (stored alongside the resolved absolute dates)
ALTER TABLE platform.schedule_events
  ADD COLUMN IF NOT EXISTS color               text,
  ADD COLUMN IF NOT EXISTS checklist_lead_days integer;

ALTER TABLE platform.event_checklist_items
  ADD COLUMN IF NOT EXISTS start_offset_days integer,
  ADD COLUMN IF NOT EXISTS end_offset_days   integer;
