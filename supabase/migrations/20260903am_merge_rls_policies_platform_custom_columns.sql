-- "Admin/dev manage custom_columns" (ALL) despite its name has no role
-- check — identical condition to the SELECT policy below.
DROP POLICY IF EXISTS "Company members read custom_columns" ON platform.custom_columns;
