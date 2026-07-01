-- Grant SELECT on forms schema tables to authenticated role so TopBar
-- and other app queries can read assignments via PostgREST.
GRANT USAGE ON SCHEMA forms TO authenticated;
GRANT SELECT ON forms.assignments TO authenticated;
GRANT SELECT ON forms.forms TO authenticated;

-- Move task_popup_dismissals from inventory to core (matches tasks move).
ALTER TABLE inventory.task_popup_dismissals SET SCHEMA core;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
