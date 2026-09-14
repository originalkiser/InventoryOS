-- Custom Shop Config originally applied every field's value uniformly to
-- every package a shop's custom setup was flagged for — fine for Shop
-- Supply Fee/Oil Inflation Surcharge (genuinely shop-wide), wrong for
-- Price Per Quart/Included Quarts once a shop has custom pricing on MORE
-- THAN ONE package: those two need their own value per package (a shop
-- might sell one package's oil at $4.25/qt and another's at $5.00/qt),
-- not one value applied identically everywhere.
--
-- per_package (on the field TYPE) marks which kinds of custom thing vary
-- by package vs. apply once per shop — set for the two existing fields it
-- was actually asked for; future field types default to shop-wide (false)
-- unless explicitly marked otherwise from the Custom Shop Config page.
ALTER TABLE inventory.custom_shop_config_fields
  ADD COLUMN IF NOT EXISTS per_package boolean NOT NULL DEFAULT false;

UPDATE inventory.custom_shop_config_fields
SET per_package = true
WHERE lower(name) IN ('price per quart', 'included quarts');

-- package_key on the VALUE itself — '' (NOT NULL, not a nullable column)
-- for a shop-wide field, set to a specific package for a per_package
-- field's per-package value. NOT NULL with an empty-string sentinel rather
-- than a nullable column deliberately: PostgREST's .upsert(data,
-- {onConflict: 'a,b,c'}) generates a plain `ON CONFLICT (a,b,c)` naming
-- those literal columns, which only matches a REAL unique constraint on
-- those exact columns — Postgres treats every NULL as distinct from every
-- other NULL, so a plain UNIQUE(..., package_key) with package_key
-- nullable would have silently allowed duplicate shop-wide rows instead of
-- upserting over the existing one, and an expression index on
-- COALESCE(package_key,'') (the other way to fix that) doesn't match a
-- plain-column onConflict target at all, so upsert would fail outright
-- with "no unique or exclusion constraint matching". A NOT NULL default
-- avoids both problems using the exact same upsert shape every other table
-- in this app already uses.
-- Written defensively (ADD nullable, backfill, THEN set NOT NULL/default)
-- rather than one ADD COLUMN ... NOT NULL DEFAULT '' — this migration was
-- corrected after an earlier draft of it already ran against production
-- with package_key left nullable and a since-abandoned expression unique
-- index, so it has to reach the right end state from either a fresh
-- database or that already-partially-migrated one.
ALTER TABLE inventory.custom_shop_config_values ADD COLUMN IF NOT EXISTS package_key text;
UPDATE inventory.custom_shop_config_values SET package_key = '' WHERE package_key IS NULL;
ALTER TABLE inventory.custom_shop_config_values ALTER COLUMN package_key SET DEFAULT '';
ALTER TABLE inventory.custom_shop_config_values ALTER COLUMN package_key SET NOT NULL;

DROP INDEX IF EXISTS inventory.custom_shop_config_values_unique_idx;
ALTER TABLE inventory.custom_shop_config_values DROP CONSTRAINT IF EXISTS custom_shop_config_values_company_id_location_id_field_id_key;
ALTER TABLE inventory.custom_shop_config_values DROP CONSTRAINT IF EXISTS custom_shop_config_values_unique;
ALTER TABLE inventory.custom_shop_config_values ADD CONSTRAINT custom_shop_config_values_unique UNIQUE (company_id, location_id, field_id, package_key);
