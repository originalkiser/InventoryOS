-- Menu Board (Marketing) — a per-shop, on-screen recreation of the printed
-- lobby/bay menu board, with pricing pulled live from core.locations
-- instead of needing a separate price-entry system. The per-package
-- prices (economy, premium_hm, premium_full_synthetic,
-- premium_full_synthetic_hm, rp) already exist as real core.locations
-- columns (confirmed live against a real board PDF for shop 274: economy
-- 49.99, premium_hm 76.99, premium_full_synthetic 94.99,
-- premium_full_synthetic_hm 99.99, rp 119.99 — an exact match) — populated
-- by the Monday.com Locations sync. This table set adds: (a) an explicit,
-- editable mapping from a board package to its source column, so a column
-- rename or a newly-added package (Dexos, mentioned as "coming later")
-- doesn't require a code change; (b) each package's admin-adjustable
-- on-board text position/size; (c) company-default and per-location
-- price-per-extra-quart, mirroring the exact default+override shape
-- ov2_product_exceptions already established for Orders v2.

CREATE TABLE IF NOT EXISTS marketing.menu_board_packages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  package_key        text        NOT NULL,
  display_name       text        NOT NULL,
  -- Small qualifier line some tiers carry on the real board ("GREAT FOR
  -- OVER 75,000 MILES" / "NOT RECOMMENDED FOR OVER 75,000 MILES").
  qualifier          text,
  -- The core.locations column this package's price comes from. NULL for a
  -- package that's been added to the board's lineup but has no priced
  -- column yet (e.g. Dexos, per explicit note) — it shows on the config
  -- list as needing a mapping before it can go active.
  price_column       text,
  sort_order         integer     NOT NULL DEFAULT 0,
  active             boolean     NOT NULL DEFAULT true,
  -- Board layout, percentage-based (0-100 of the board's own width/height)
  -- so it stays correct regardless of what size the board actually renders
  -- at. Defaults land every package in a sensible starting spot; adjusted
  -- per package from the Menu Board admin view, not hardcoded in code.
  price_pos_x        numeric     NOT NULL DEFAULT 50,
  price_pos_y        numeric     NOT NULL DEFAULT 50,
  price_font_size    numeric     NOT NULL DEFAULT 48,
  quart_pos_x        numeric     NOT NULL DEFAULT 50,
  quart_pos_y        numeric     NOT NULL DEFAULT 60,
  quart_font_size    numeric     NOT NULL DEFAULT 16,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, package_key)
);

-- Company-wide default price-per-extra-quart and how many quarts are
-- already included in the base price, per package.
CREATE TABLE IF NOT EXISTS marketing.menu_board_quart_defaults (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  package_key        text        NOT NULL,
  price_per_quart    numeric,
  included_quarts    integer,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, package_key)
);

-- Per-location override of the above, for a shop that's been explicitly
-- set to a different extra-quart price/allowance than the company
-- default — the Menu Board admin's "Custom" list is just every row here.
CREATE TABLE IF NOT EXISTS marketing.menu_board_quart_overrides (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  package_key        text        NOT NULL,
  price_per_quart    numeric,
  included_quarts    integer,
  notes              text,
  updated_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, package_key)
);

ALTER TABLE marketing.menu_board_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.menu_board_quart_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing.menu_board_quart_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "menu_board_packages_select" ON marketing.menu_board_packages;
CREATE POLICY "menu_board_packages_select" ON marketing.menu_board_packages FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "menu_board_packages_manage" ON marketing.menu_board_packages;
CREATE POLICY "menu_board_packages_manage" ON marketing.menu_board_packages FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "menu_board_quart_defaults_select" ON marketing.menu_board_quart_defaults;
CREATE POLICY "menu_board_quart_defaults_select" ON marketing.menu_board_quart_defaults FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "menu_board_quart_defaults_manage" ON marketing.menu_board_quart_defaults;
CREATE POLICY "menu_board_quart_defaults_manage" ON marketing.menu_board_quart_defaults FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "menu_board_quart_overrides_select" ON marketing.menu_board_quart_overrides;
CREATE POLICY "menu_board_quart_overrides_select" ON marketing.menu_board_quart_overrides FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "menu_board_quart_overrides_manage" ON marketing.menu_board_quart_overrides;
CREATE POLICY "menu_board_quart_overrides_manage" ON marketing.menu_board_quart_overrides FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_menu_board_quart_overrides_location ON marketing.menu_board_quart_overrides (company_id, location_id);

-- Seed the 5 packages currently on the real board (order + qualifiers +
-- price_column confirmed against the shop-274 board PDF), plus Dexos as an
-- inactive placeholder with no price_column yet (per explicit "not in menu
-- yet, but will be added later"). Position defaults stack the 5 active
-- tiers top-to-bottom in even bands; adjust from the admin view once real
-- artwork is in place.
INSERT INTO marketing.menu_board_packages
  (company_id, package_key, display_name, qualifier, price_column, sort_order, active, price_pos_y, quart_pos_y)
SELECT DISTINCT company_id, v.package_key, v.display_name, v.qualifier, v.price_column, v.sort_order, v.active, v.price_pos_y, v.quart_pos_y
FROM core.locations, (VALUES
  ('valvoline_restore_protect',    'Valvoline Restore & Protect',        NULL,                                  'rp',                        1, true,  10::numeric, 16::numeric),
  ('premium_full_synthetic_hm',    'Premium Full Synthetic High Mileage','GREAT FOR OVER 75,000 MILES',         'premium_full_synthetic_hm', 2, true,  28::numeric, 34::numeric),
  ('premium_full_synthetic_dexos', 'Premium Full Synthetic Dexos',       NULL,                                  NULL,                        3, false, 46::numeric, 52::numeric),
  ('premium_full_synthetic',       'Premium Full Synthetic',             NULL,                                  'premium_full_synthetic',    4, true,  46::numeric, 52::numeric),
  ('premium_hm',                   'Premium High Mileage',               'GREAT FOR OVER 75,000 MILES',         'premium_hm',                5, true,  64::numeric, 70::numeric),
  ('economy',                      'Economy',                            'NOT RECOMMENDED FOR OVER 75,000 MILES','economy',                  6, true,  82::numeric, 88::numeric)
) AS v(package_key, display_name, qualifier, price_column, sort_order, active, price_pos_y, quart_pos_y)
ON CONFLICT (company_id, package_key) DO NOTHING;

-- Company-default price-per-extra-quart, confirmed against the same board
-- (all tiers currently include up to 5 quarts in the base price).
INSERT INTO marketing.menu_board_quart_defaults (company_id, package_key, price_per_quart, included_quarts)
SELECT DISTINCT company_id, v.package_key, v.price_per_quart, 5
FROM core.locations, (VALUES
  ('valvoline_restore_protect', 12.99::numeric),
  ('premium_full_synthetic_hm', 11.99::numeric),
  ('premium_full_synthetic', 10.99::numeric),
  ('premium_hm', 9.99::numeric),
  ('economy', 8.99::numeric)
) AS v(package_key, price_per_quart)
ON CONFLICT (company_id, package_key) DO NOTHING;
