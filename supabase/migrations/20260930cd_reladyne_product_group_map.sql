-- RelaDyne MMR "Product Gallons" tab (direct ask 2026-10-02): the source
-- StricklandData sheet only tags a product PACKAGE or BULK, but this MMR
-- (and only this MMR, for now) wants Package split into Package vs Drum —
-- three groups total. Default grouping is derived in code (BULK -> bulk,
-- PACKAGE whose description ends in " DR" -> drum, other PACKAGE -> package,
-- see mmrShared.ts defaultGroupFor) so a brand-new product classifies itself
-- without any maintenance; a row here is an explicit OVERRIDE for one
-- product (presence = override, same convention as custom_product_pricing).
-- Keyed by product_desc, matching how every other MMR tab keys products.
CREATE TABLE IF NOT EXISTS inventory.reladyne_product_group_map (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  product_desc text NOT NULL,
  group_key   text NOT NULL CHECK (group_key IN ('bulk', 'package', 'drum')),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, product_desc)
);
ALTER TABLE inventory.reladyne_product_group_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "reladyne_product_group_map_select" ON inventory.reladyne_product_group_map;
CREATE POLICY "reladyne_product_group_map_select" ON inventory.reladyne_product_group_map FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "reladyne_product_group_map_manage" ON inventory.reladyne_product_group_map;
CREATE POLICY "reladyne_product_group_map_manage" ON inventory.reladyne_product_group_map FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
