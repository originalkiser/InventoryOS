-- Move tasks table from inventory schema to core schema.
-- project_tasks remains in inventory (project-scoped data).

ALTER TABLE inventory.tasks SET SCHEMA core;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
