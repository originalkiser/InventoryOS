-- ============================================================
-- Move core.global_products into the inventory schema.
--
-- Same story as uom_mappings (20260821) and vendors/vendor_parts
-- (20260818d) before it: created in the original pre-schema-split core
-- batch and never actually moved. Every app reference already assumes
-- inventory.global_products — GlobalProductsTab.tsx (Config UI),
-- NewOrderTab.tsx, and useOrdersV2.ts's on-hand-unit conversion all
-- query .schema('inventory').from('global_products') — so the table has
-- been silently returning zero rows with no error this whole time. No
-- code needs to change; only the table's actual location does.
--
-- ALTER TABLE ... SET SCHEMA is metadata-only — no data copied/rewritten,
-- near-instant regardless of table size. RLS/indexes move automatically.
--
-- Safe to re-run.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'global_products')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'inventory' AND table_name = 'global_products') THEN
    ALTER TABLE core.global_products SET SCHEMA inventory;
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
