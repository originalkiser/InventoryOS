-- Grant service_role access to custom schemas used by Edge Functions.
-- service_role bypasses RLS but still needs explicit USAGE on schemas and
-- table-level privileges to read/write via PostgREST.

-- core schema
GRANT USAGE ON SCHEMA core TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA core TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT ALL ON TABLES TO service_role;

-- inventory schema
GRANT USAGE ON SCHEMA inventory TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA inventory TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA inventory GRANT ALL ON TABLES TO service_role;

-- platform schema
GRANT USAGE ON SCHEMA platform TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA platform TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform GRANT ALL ON TABLES TO service_role;

-- outlier schema
GRANT USAGE ON SCHEMA outlier TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA outlier TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA outlier GRANT ALL ON TABLES TO service_role;
