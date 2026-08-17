-- Ensure forms.forms.category exists and PostgREST sees it.
-- The column was defined in 20260624000000_form_visibility.sql, but production
-- was erroring "Could not find the 'category' column of 'forms' in the schema
-- cache" — either the column is missing or PostgREST's schema cache is stale.
-- Both statements below are safe to run repeatedly.

alter table forms.forms add column if not exists category text;

-- Force PostgREST to reload its schema cache so the column is visible via the API.
notify pgrst, 'reload schema';
