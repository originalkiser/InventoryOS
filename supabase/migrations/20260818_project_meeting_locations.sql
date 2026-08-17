-- Locations linked to projects and meeting notes, so the Location Lookup
-- "Mentioned" section can show which projects/meetings reference a shop.
-- Safe to re-run.

alter table inventory.projects
  add column if not exists location_ids uuid[] not null default '{}';

alter table inventory.meeting_notes
  add column if not exists location_ids uuid[] not null default '{}';

-- Speeds up the "contains this location" lookup from Location Lookup.
create index if not exists idx_inv_projects_location_ids on inventory.projects using gin (location_ids);
create index if not exists idx_inv_meeting_notes_location_ids on inventory.meeting_notes using gin (location_ids);

notify pgrst, 'reload schema';
