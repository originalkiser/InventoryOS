-- Droptop's own get-inventory response carries a real per-product unit_cost
-- (confirmed live via droptop-sync-usage's mode:'inspect' — e.g. Cabin Air
-- Filter unit_cost 4.95, Engine Oil Additive unit_cost 0.17), never captured
-- before now. product_usage.unit_cost lets the sync store it; count_products'
-- own pre-existing ending_value column (previously only ever populated by a
-- manual Product Detail upload) can now be computed as on_hand * unit_cost
-- for a Droptop-fed period too — real per-product dollar value across every
-- category (Oil/Parts/Additives/Other), not just the vendor_parts-based
-- price-per-gallon estimate that only ever covered Oil.
ALTER TABLE inventory.product_usage ADD COLUMN IF NOT EXISTS unit_cost numeric;
