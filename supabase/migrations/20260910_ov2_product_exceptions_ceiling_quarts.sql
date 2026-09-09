-- Product Exceptions' ceiling unit was cases/gallons only — confusing per
-- explicit user feedback ("Cases (this product's own unit)" read as vague),
-- and missing the plain quarts option entirely. Widened to also allow
-- 'quarts' — the UI now offers the SELECTED product's own real case type
-- (Case/Drum/Bay Box/Bulk, whatever it's actually configured as), Quarts,
-- or Gallons.
ALTER TABLE inventory.ov2_product_exceptions DROP CONSTRAINT IF EXISTS ov2_product_exceptions_ceiling_unit_check;
ALTER TABLE inventory.ov2_product_exceptions ADD CONSTRAINT ov2_product_exceptions_ceiling_unit_check
  CHECK (ceiling_unit IN ('cases', 'gallons', 'quarts'));
