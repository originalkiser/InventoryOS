-- Count Sheet (proof of concept): a shop's working sheet for counting every Droptop product. Counts are kept here only — nothing is
-- pushed to Droptop yet. A sheet has user-defined places (bays, shelves, rooms…) and entries: one per product per place, as many
-- entries per product as the counter needs.

-- Droptop's own "Seq. ID" (the order Droptop lists products for counting), when the inventory feed provides it.
ALTER TABLE inventory.product_usage ADD COLUMN IF NOT EXISTS count_sequence integer;

CREATE TABLE IF NOT EXISTS inventory.count_sheets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  location_id uuid NOT NULL,
  label       text NOT NULL,
  count_date  date NOT NULL DEFAULT current_date,
  notes       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_count_sheets_loc ON inventory.count_sheets (company_id, location_id, count_date DESC);

CREATE TABLE IF NOT EXISTS inventory.count_sheet_places (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id   uuid NOT NULL,
  company_id uuid NOT NULL,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_count_sheet_places_sheet ON inventory.count_sheet_places (sheet_id);

CREATE TABLE IF NOT EXISTS inventory.count_sheet_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_id    uuid NOT NULL,
  company_id  uuid NOT NULL,
  product_id  text NOT NULL,
  place_id    uuid,                 -- null = not assigned to a place
  qty         numeric,              -- null = on the sheet but not counted yet
  sort_order  integer NOT NULL DEFAULT 0,
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_count_sheet_entries_sheet ON inventory.count_sheet_entries (sheet_id, product_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['count_sheets', 'count_sheet_places', 'count_sheet_entries'] LOOP
    EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_select', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR SELECT USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON inventory.%I', t || '_manage', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR ALL USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())) WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))', t || '_manage', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.%I TO authenticated', t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
