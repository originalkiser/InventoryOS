-- One-time cleanup for inventory.product_usage: the POS API integration has
-- been creating a new row per pull instead of updating the existing one for
-- the same (company, location, product), leaving stale duplicate on-hand
-- rows behind. This collapses each (company_id, location_id, product_id)
-- group down to its most recently updated row, then adds a unique index so
-- the same key can never produce more than one row again.
--
-- Does NOT touch inventory.product_id_mappings (the separate POS-product-id
-- -> internal-product-id crosswalk on the Product Mapping config tab) — that
-- table isn't referenced here, so its mappings are untouched by this cleanup.
-- Safe to re-run: the DELETE only ever removes rows already dominated by a
-- newer duplicate, and CREATE UNIQUE INDEX IF NOT EXISTS is a no-op once applied.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY company_id, location_id, lower(product_id)
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM inventory.product_usage
)
DELETE FROM inventory.product_usage
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_usage_company_location_product
  ON inventory.product_usage (company_id, location_id, lower(product_id));
