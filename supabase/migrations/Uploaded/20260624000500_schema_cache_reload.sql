-- Force PostgREST to reload its schema cache.
-- Run this if the Supabase API returns "could not find column X in schema cache"
-- after a previous migration added new columns to inventory.recount_config.
SELECT pg_notify('pgrst', 'reload schema');
