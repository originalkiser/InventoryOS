-- The Package Mapping pricing audit's "Location List Column" mapping was
-- hardcoded to the 5 canonical Menu Board packages (economy, premium_hm,
-- premium_full_synthetic, premium_full_synthetic_hm, rp) via
-- FRANCHISE_PACKAGE_KEYS, since that's what the original 20260930ae
-- migration built it against. Real request 2026-09-19: some real Droptop
-- oil-change packages need mapping to core.locations price columns that
-- exist on the location list but were never part of the Menu Board's
-- fixed 5-package layout — diesel_syn_blend, diesel_full_syn, european
-- (confirmed real numeric columns on core.locations via
-- information_schema.columns; supply_fee/disposal_fee/oil_inflation_
-- surcharge are FEES, not oil-change service tiers, and are deliberately
-- excluded from this mapping).
ALTER TABLE inventory.droptop_package_classification
  DROP CONSTRAINT droptop_package_classification_price_column_check;

ALTER TABLE inventory.droptop_package_classification
  ADD CONSTRAINT droptop_package_classification_price_column_check
    CHECK (price_column IS NULL OR price_column IN (
      'economy', 'premium_hm', 'premium_full_synthetic', 'premium_full_synthetic_hm', 'rp',
      'diesel_syn_blend', 'diesel_full_syn', 'european'
    ));
