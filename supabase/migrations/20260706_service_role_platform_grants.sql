-- Grant service_role access to the platform schema.
-- The invite-user Edge Function creates user profiles using the service-role
-- admin client, which runs as the service_role Postgres role. Without these
-- grants, PostgREST returns "permission denied for schema platform" even
-- though the service role bypasses RLS.

GRANT USAGE ON SCHEMA platform TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA platform TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA platform TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform
  GRANT ALL ON SEQUENCES TO service_role;
