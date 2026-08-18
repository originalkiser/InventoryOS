-- ============================================================
-- Move core.vendors / core.vendor_parts into the inventory schema.
--
-- These two tables have lived in `core` since 0001_initial_schema.sql
-- (created before the schema was ever split), while everything else they
-- relate to — global_products, uom_mappings, location_order_config,
-- product_usage — is in `inventory`. That mismatch is what let a
-- `.schema('inventory').from('vendor_parts')` query silently return zero
-- rows (no error) instead of failing loudly, which broke Product Usage's
-- vendor-part-number import undetected. Moving the tables to where they
-- conceptually belong removes the whole class of "which schema is this
-- actually in" mistake going forward.
--
-- ALTER TABLE ... SET SCHEMA is a metadata-only operation — no data is
-- copied or rewritten, and it's near-instant regardless of table size.
-- Attached RLS policies, indexes, and foreign keys all move with the
-- table automatically; nothing else needs to change on the database side.
--
-- IMPORTANT: run this BEFORE deploying the matching frontend change (the
-- commit that switches every `.schema('core').from('vendors' | 'vendor_parts')`
-- call to `.schema('inventory')`). Deploying the code first would break
-- every vendor/vendor-parts read and write until this runs.
-- ============================================================

ALTER TABLE core.vendors SET SCHEMA inventory;
ALTER TABLE core.vendor_parts SET SCHEMA inventory;
