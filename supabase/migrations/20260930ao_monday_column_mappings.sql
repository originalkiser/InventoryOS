-- Monday.com column-mapper UI (2026-09-20 request) — lets an admin browse
-- every column on the "Open Stores List" board, see which aren't yet wired
-- into monday-sync-locations' FIELD_MAP, and add one from SB Net directly:
-- creates the matching core.locations column and records the mapping so
-- future syncs (no code deploy needed) pick it up. The ~90 existing
-- FIELD_MAP entries stay exactly as they are, hardcoded in the edge
-- function — this table is additive, for mappings created from this UI
-- going forward.
CREATE TABLE IF NOT EXISTS core.monday_column_mappings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL,
  monday_column_id    text        NOT NULL,
  monday_column_title text        NOT NULL,
  monday_column_type  text        NOT NULL,
  core_column         text        NOT NULL,
  field_kind          text        NOT NULL CHECK (field_kind IN ('text', 'mirror', 'relation', 'bool', 'int', 'numeric', 'date', 'phone')),
  pg_type             text        NOT NULL CHECK (pg_type IN ('text', 'boolean', 'integer', 'numeric', 'date', 'timestamptz')),
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, monday_column_id),
  UNIQUE (company_id, core_column)
);

ALTER TABLE core.monday_column_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "monday_column_mappings_select" ON core.monday_column_mappings
  FOR SELECT USING (company_id = get_my_company_id());

-- Deliberately no INSERT/UPDATE/DELETE policy — every write goes through
-- add_monday_mapped_column() below, which validates the column name/type
-- before running any DDL. A SECURITY DEFINER function's owner bypasses RLS
-- (same as every other admin RPC in this app), so this doesn't block it.

-- Runs the actual ALTER TABLE — the one genuinely privileged step in this
-- feature. Validates everything before touching schema: caller must be
-- admin/developer (is_admin()), the column name must be a safe lower-
-- snake-case identifier, the Postgres type must be one of a small
-- whitelist, and the column must not already exist. p_pg_type is
-- interpolated via format()'s %s (not %I/%L) but is only ever one of the
-- 6 literal values the CHECK constraint above (and this same whitelist)
-- allows — never client-supplied free text reaching the executed SQL.
CREATE OR REPLACE FUNCTION core.add_monday_mapped_column(
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
