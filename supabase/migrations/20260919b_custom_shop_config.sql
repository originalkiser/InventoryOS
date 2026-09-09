-- Custom Shop Config — a place for the per-shop exceptions that don't fit
-- anywhere else: a shop with its own price-per-quart, its own included-
-- quarts count, a custom shop supply fee, an oil inflation surcharge, etc.
-- The list of *kinds* of custom thing a shop can have is itself
-- admin-extensible (custom_shop_config_fields — "create-able dropdown
-- options"), not a hardcoded column set, since new one-off shop
-- arrangements come up over time. Separately, a shop can flag which Menu
-- Board package(s) its custom setup actually applies to.
--
-- "Which shops have custom config" is just "every shop with a row in
-- custom_shop_config_values or custom_shop_config_packages" — same
-- default+override philosophy as ov2_product_exceptions and the Menu
-- Board's quart-pricing overrides.

CREATE TABLE IF NOT EXISTS inventory.custom_shop_config_fields (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  name         text        NOT NULL,
  -- How to parse/format a value for this field — currency ($X.XX), number
  -- (plain count), percent (X.X%), or text (free-form, e.g. a reason/note
  -- masquerading as a field rather than a real number).
  value_kind   text        NOT NULL DEFAULT 'currency' CHECK (value_kind IN ('currency', 'number', 'percent', 'text')),
  sort_order   integer     NOT NULL DEFAULT 0,
  active       boolean     NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS inventory.custom_shop_config_values (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  location_id  uuid        NOT NULL,
  field_id     uuid        NOT NULL REFERENCES inventory.custom_shop_config_fields(id) ON DELETE CASCADE,
  value        text,
  notes        text,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, field_id)
);

-- Menu Board package_key is plain text, matching this app's no-cross-schema-
-- FK convention (see CLAUDE.md) — not a hard FK to marketing.menu_board_packages.
CREATE TABLE IF NOT EXISTS inventory.custom_shop_config_packages (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL,
  location_id  uuid        NOT NULL,
  package_key  text        NOT NULL,
  notes        text,
  updated_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, package_key)
);

CREATE INDEX IF NOT EXISTS idx_custom_shop_config_values_location ON inventory.custom_shop_config_values (company_id, location_id);
CREATE INDEX IF NOT EXISTS idx_custom_shop_config_packages_location ON inventory.custom_shop_config_packages (company_id, location_id);

ALTER TABLE inventory.custom_shop_config_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.custom_shop_config_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.custom_shop_config_packages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "custom_shop_config_fields_select" ON inventory.custom_shop_config_fields;
CREATE POLICY "custom_shop_config_fields_select" ON inventory.custom_shop_config_fields FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_shop_config_fields_manage" ON inventory.custom_shop_config_fields;
CREATE POLICY "custom_shop_config_fields_manage" ON inventory.custom_shop_config_fields FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "custom_shop_config_values_select" ON inventory.custom_shop_config_values;
CREATE POLICY "custom_shop_config_values_select" ON inventory.custom_shop_config_values FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_shop_config_values_manage" ON inventory.custom_shop_config_values;
CREATE POLICY "custom_shop_config_values_manage" ON inventory.custom_shop_config_values FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "custom_shop_config_packages_select" ON inventory.custom_shop_config_packages;
CREATE POLICY "custom_shop_config_packages_select" ON inventory.custom_shop_config_packages FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "custom_shop_config_packages_manage" ON inventory.custom_shop_config_packages;
CREATE POLICY "custom_shop_config_packages_manage" ON inventory.custom_shop_config_packages FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Seed the field types named in the initial request — starting points, not
-- a fixed list; admins add more from the Custom Shop Config page.
INSERT INTO inventory.custom_shop_config_fields (company_id, name, value_kind, sort_order)
SELECT DISTINCT company_id, v.name, v.value_kind, v.sort_order
FROM core.locations, (VALUES
  ('Price Per Quart',        'currency', 1),
  ('Included Quarts',        'number',   2),
  ('Shop Supply Fee',        'currency', 3),
  ('Oil Inflation Surcharge','currency', 4)
) AS v(name, value_kind, sort_order)
ON CONFLICT (company_id, name) DO NOTHING;
