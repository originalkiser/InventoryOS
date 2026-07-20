-- Per-user location exclusion rules for listing/dashboard surfaces.
-- Shape: [{ "field": "region", "values": ["Southeast"] }, ...]
-- field is a base column (region, district, name, shop_city) or a metadata
-- key prefixed with "meta:" (meta:owner, meta:market, meta:area_manager,
-- meta:regional_director, meta:type). A location is hidden when any rule's
-- values contain its value for that field (case-insensitive).

ALTER TABLE core.user_sidebar_prefs
  ADD COLUMN IF NOT EXISTS location_exclusions jsonb NOT NULL DEFAULT '[]'::jsonb;
