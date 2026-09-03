-- "Admin manage manual_count_entries" (ALL) despite its name has no
-- is_admin() check — identical condition to the SELECT policy below.
DROP POLICY IF EXISTS "Company members read manual_count_entries" ON inventory.manual_count_entries;
