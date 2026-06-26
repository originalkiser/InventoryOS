-- =====================================================================
-- 1. Add package_capacity to product_usage  (inventory schema)
-- =====================================================================
ALTER TABLE inventory.product_usage
  ADD COLUMN IF NOT EXISTS package_capacity numeric;

-- =====================================================================
-- 2. Create monthly_ending_balances in inventory schema (if missing)
-- =====================================================================
CREATE TABLE IF NOT EXISTS inventory.monthly_ending_balances (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  location_id         uuid,
  month               date NOT NULL,
  ending_balance      numeric NOT NULL,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by          uuid,
  last_change_source  text,
  uploaded_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory.monthly_ending_balances ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Company members read monthly_ending_balances" ON inventory.monthly_ending_balances;
  CREATE POLICY "Company members read monthly_ending_balances"
    ON inventory.monthly_ending_balances FOR SELECT
    USING (company_id = get_my_company_id());

  DROP POLICY IF EXISTS "Company members manage monthly_ending_balances" ON inventory.monthly_ending_balances;
  CREATE POLICY "Company members manage monthly_ending_balances"
    ON inventory.monthly_ending_balances FOR ALL
    USING (company_id = get_my_company_id())
    WITH CHECK (company_id = get_my_company_id());
END $$;

-- =====================================================================
-- 3. Create tank_monitors in inventory schema (if missing)
-- =====================================================================
CREATE TABLE IF NOT EXISTS inventory.tank_monitors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL,
  location_id         uuid,
  reading_date        date NOT NULL DEFAULT CURRENT_DATE,
  value               numeric,
  unit                text DEFAULT 'gal',
  product_id          text,
  keep_fill           boolean NOT NULL DEFAULT false,
  on_hand             numeric,
  inventory_time      timestamptz,
  updated_by          uuid,
  last_change_source  text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tank_monitors_company
  ON inventory.tank_monitors (company_id, reading_date);

ALTER TABLE inventory.tank_monitors ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Company members read tank_monitors" ON inventory.tank_monitors;
  CREATE POLICY "Company members read tank_monitors"
    ON inventory.tank_monitors FOR SELECT
    USING (company_id = get_my_company_id());

  DROP POLICY IF EXISTS "Company members manage tank_monitors" ON inventory.tank_monitors;
  CREATE POLICY "Company members manage tank_monitors"
    ON inventory.tank_monitors FOR ALL
    USING (company_id = get_my_company_id())
    WITH CHECK (company_id = get_my_company_id());
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
SET search_path = inventory, public
AS $$
  SELECT
    id, location_id, product_id,
    NULLIF(TRIM(COALESCE(category, '')), '') AS category,
    daily_usage, on_hands, package_capacity, days_of_supply,
    updated_by, last_change_source, created_at, updated_at
  FROM inventory.product_usage
  WHERE company_id = p_company_id
  ORDER BY product_id, location_id NULLS LAST;
$$;
