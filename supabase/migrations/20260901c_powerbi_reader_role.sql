-- Read-only Postgres role for Power BI (or any other direct-connection BI
-- tool) to pull data straight out of Supabase's Postgres instance — no
-- edge function, no API, no custom connector needed. Power BI's built-in
-- "PostgreSQL database" data source connects directly with a host/port/
-- database/user/password, exactly like connecting to any other Postgres.
-- That's genuinely all "prebuilt, ready to go, just authenticate and pull"
-- means here: this migration creates the login and the grants; Power BI
-- supplies nothing extra beyond what it already knows how to do for any
-- Postgres database.
--
-- IMPORTANT — do this right after applying this migration, before using the
-- role anywhere: the password below is a placeholder, not a real secret.
-- Rotate it immediately from the Supabase SQL editor:
--   ALTER ROLE powerbi_reader WITH PASSWORD 'put a real generated password here';
-- Never commit the real password to git — this file only creates the role
-- and its permissions, not a usable credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'powerbi_reader') THEN
    CREATE ROLE powerbi_reader WITH LOGIN PASSWORD 'CHANGE_ME_IMMEDIATELY' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Scoped to what the Customer Heatmap needs today: the customer data itself,
-- the zip centroid lookup it's plotted against, and core.locations so a
-- Power BI report can join a customer row back to a shop name/region rather
-- than just a bare location_id. Extend later with more GRANT statements in
-- a new migration as more reporting needs come up — this role's access is
-- additive and centrally auditable here, not something Power BI itself
-- controls.
GRANT USAGE ON SCHEMA inventory TO powerbi_reader;
GRANT USAGE ON SCHEMA core TO powerbi_reader;
GRANT SELECT ON inventory.droptop_customers TO powerbi_reader;
GRANT SELECT ON inventory.zip_centroids TO powerbi_reader;
GRANT SELECT ON core.locations TO powerbi_reader;

-- So a table added to these schemas *later* is readable by this role
-- automatically, without a follow-up GRANT — matches the additive intent
-- above without silently exposing schemas this role wasn't given USAGE on.
ALTER DEFAULT PRIVILEGES IN SCHEMA inventory GRANT SELECT ON TABLES TO powerbi_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT ON TABLES TO powerbi_reader;

-- Row Level Security still applies to this role like any other non-owner,
-- non-superuser login (Postgres enforces RLS on every role but the table
-- owner and BYPASSRLS roles by default) — droptop_customers'/core.locations'
-- existing policies key off platform.user_profiles by auth.uid(), which
-- this role has none of, so those tables would return zero rows to it
-- rather than "access denied". Add an explicit SELECT-to-powerbi_reader
-- policy alongside the existing ones (not a role-wide RLS bypass, and
-- deliberately not FORCE ROW LEVEL SECURITY — that flag changes behavior
-- for the table *owner*, not this role, and touching it here risked
-- affecting whatever other role/process already owns these tables).
DROP POLICY IF EXISTS "droptop_customers_powerbi" ON inventory.droptop_customers;
CREATE POLICY "droptop_customers_powerbi" ON inventory.droptop_customers FOR SELECT TO powerbi_reader USING (true);

DROP POLICY IF EXISTS "zip_centroids_powerbi" ON inventory.zip_centroids;
CREATE POLICY "zip_centroids_powerbi" ON inventory.zip_centroids FOR SELECT TO powerbi_reader USING (true);

DROP POLICY IF EXISTS "locations_powerbi" ON core.locations;
CREATE POLICY "locations_powerbi" ON core.locations FOR SELECT TO powerbi_reader USING (true);
