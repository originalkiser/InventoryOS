-- =====================================================================
-- 1. Add package_capacity to product_usage
-- =====================================================================
ALTER TABLE product_usage
  ADD COLUMN IF NOT EXISTS package_capacity numeric;

-- =====================================================================
-- 2. Create monthly_ending_balances if it doesn't exist
--    (public schema — matches 0001_initial_schema + phase4_custom_fields)
-- =====================================================================
CREATE TABLE IF NOT EXISTS monthly_ending_balances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id         uuid REFERENCES locations(id) ON DELETE CASCADE,
  month               date NOT NULL,
  ending_balance      numeric NOT NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid REFERENCES auth.users ON DELETE SET NULL,
  last_change_source  text,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE monthly_ending_balances ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Company members read monthly_ending_balances" ON monthly_ending_balances;
  CREATE POLICY "Company members read monthly_ending_balances"
    ON monthly_ending_balances FOR SELECT
    USING (company_id = get_my_company_id());

  DROP POLICY IF EXISTS "Company members manage monthly_ending_balances" ON monthly_ending_balances;
  CREATE POLICY "Company members manage monthly_ending_balances"
    ON monthly_ending_balances FOR ALL
    USING (company_id = get_my_company_id())
    WITH CHECK (company_id = get_my_company_id());
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE monthly_ending_balances;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================================
-- 3. Create tank_monitors if it doesn't exist
--    (public schema — matches batch2_config + tank_monitor_cols + tank_inventory_time)
-- =====================================================================
CREATE TABLE IF NOT EXISTS tank_monitors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id         uuid REFERENCES locations(id) ON DELETE SET NULL,
  reading_date        date NOT NULL DEFAULT CURRENT_DATE,
  value               numeric,
  unit                text DEFAULT 'gal',
  updated_by          uuid REFERENCES auth.users ON DELETE SET NULL,
  last_change_source  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tank_monitors
  ADD COLUMN IF NOT EXISTS product_id      text,
  ADD COLUMN IF NOT EXISTS keep_fill       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS on_hand         numeric,
  ADD COLUMN IF NOT EXISTS inventory_time  timestamptz;

CREATE INDEX IF NOT EXISTS idx_tank_monitors_company ON tank_monitors (company_id, reading_date);

ALTER TABLE tank_monitors ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Company members read tank_monitors" ON tank_monitors;
  CREATE POLICY "Company members read tank_monitors"
    ON tank_monitors FOR SELECT
    USING (company_id = get_my_company_id());

  DROP POLICY IF EXISTS "Company members manage tank_monitors" ON tank_monitors;
  CREATE POLICY "Company members manage tank_monitors"
    ON tank_monitors FOR ALL
    USING (company_id = get_my_company_id())
    WITH CHECK (company_id = get_my_company_id());
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE tank_monitors;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================================
-- 4. Update get_product_usage RPC to include package_capacity
-- =====================================================================
CREATE OR REPLACE FUNCTION get_product_usage(p_company_id uuid)
RETURNS TABLE(
  id                  uuid,
  location_id         uuid,
  product_id          text,
  category            text,
  daily_usage         numeric,
  on_hands            numeric,
  package_capacity    numeric,
  days_of_supply      numeric,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz,
  updated_at          timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    id, location_id, product_id,
    NULLIF(TRIM(COALESCE(category, '')), '') AS category,
    daily_usage, on_hands, package_capacity, days_of_supply,
    updated_by, last_change_source, created_at, updated_at
  FROM product_usage
  WHERE company_id = p_company_id
  ORDER BY product_id, location_id NULLS LAST;
$$;
