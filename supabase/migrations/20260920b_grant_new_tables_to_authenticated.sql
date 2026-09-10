-- The Menu Board (20260910b), Custom Shop Config (20260919b) and Droptop
-- Packages (20260920) migrations all set up RLS policies but never granted
-- the underlying table privileges to `authenticated` — so PostgREST/the
-- client got "permission denied for table" on every read (silently
-- swallowed by the hooks) and the Package Mapping / Quart Pricing / Custom
-- Shop Config / Droptop Packages UIs all showed empty. RLS is a filter ON
-- TOP of grants, not a substitute. The `marketing` schema has no
-- default-privileges rule (the campaign-planning tables were granted
-- explicitly), and `inventory`'s default-privileges rule only fires for
-- objects created by `postgres`, not by the migration runner — so both
-- sets of tables need explicit grants.

GRANT SELECT, INSERT, UPDATE, DELETE ON
  marketing.menu_board_packages,
  marketing.menu_board_quart_defaults,
  marketing.menu_board_quart_overrides,
  inventory.custom_shop_config_fields,
  inventory.custom_shop_config_values,
  inventory.custom_shop_config_packages
TO authenticated;

-- Droptop packages are written only by the edge function (service_role),
-- read-only for the client.
GRANT SELECT ON
  inventory.droptop_packages,
  inventory.droptop_package_casual_items
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  marketing.menu_board_packages,
  marketing.menu_board_quart_defaults,
  marketing.menu_board_quart_overrides,
  inventory.custom_shop_config_fields,
  inventory.custom_shop_config_values,
  inventory.custom_shop_config_packages,
  inventory.droptop_packages,
  inventory.droptop_package_casual_items
TO service_role;

NOTIFY pgrst, 'reload schema';
