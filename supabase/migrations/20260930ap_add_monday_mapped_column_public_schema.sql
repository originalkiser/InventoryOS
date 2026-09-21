-- add_monday_mapped_column (migration 20260930ao) was defined in core, but
-- every other callable RPC in this app lives in public and is invoked via
-- a plain supabase.rpc(...) with no .schema() call (confirmed against
-- ProductUsageTab.tsx's get_product_usage_category_counts and every other
-- RPC in the codebase — zero precedent for a schema-qualified .rpc() call).
-- Moving this one to public to match, rather than introducing an untested
-- new calling convention. Functionally identical otherwise.
DROP FUNCTION IF EXISTS core.add_monday_mapped_column(text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.add_monday_mapped_column(
  p_column_name text,
  p_pg_type text,
  p_monday_column_id text,
  p_monday_column_title text,
  p_monday_column_type text,
  p_field_kind text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, core
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_column_name !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'Invalid column name "%": must be lowercase snake_case, starting with a letter', p_column_name;
  END IF;

  IF p_pg_type NOT IN ('text', 'boolean', 'integer', 'numeric', 'date', 'timestamptz') THEN
    RAISE EXCEPTION 'Invalid column type: %', p_pg_type;
  END IF;

  IF p_field_kind NOT IN ('text', 'mirror', 'relation', 'bool', 'int', 'numeric', 'date', 'phone') THEN
    RAISE EXCEPTION 'Invalid field kind: %', p_field_kind;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'core' AND table_name = 'locations' AND column_name = p_column_name
  ) THEN
    RAISE EXCEPTION 'Column "%" already exists on core.locations', p_column_name;
  END IF;

  v_company_id := get_my_company_id();

  EXECUTE format('ALTER TABLE core.locations ADD COLUMN %I %s', p_column_name, p_pg_type);

  INSERT INTO core.monday_column_mappings (
    company_id, monday_column_id, monday_column_title, monday_column_type, core_column, field_kind, pg_type, created_by
  ) VALUES (
    v_company_id, p_monday_column_id, p_monday_column_title, p_monday_column_type, p_column_name, p_field_kind, p_pg_type, auth.uid()
  );
END;
$$;
