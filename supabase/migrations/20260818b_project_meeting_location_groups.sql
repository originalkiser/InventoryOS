-- Remembers *how* locations were added to a project/meeting (e.g. "all of
-- Market X" or "all for Area Manager Y") alongside the flat location_ids
-- array, so the UI can show the group selection instead of just N shop
-- chips. Purely informational — location_ids stays the source of truth for
-- "does this project/meeting mention location X" queries.
-- Safe to re-run.

alter table inventory.projects
  add column if not exists location_groups jsonb not null default '[]';

alter table inventory.meeting_notes
  add column if not exists location_groups jsonb not null default '[]';

notify pgrst, 'reload schema';
