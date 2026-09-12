-- Package classification for M5% tracking (M5 = "Maintenance 5": Air
-- Filter, Cabin Air Filter, Wiper Blade Replacement, Additives, Tire
-- Rotation — additional-sale packages tracked as a % of oil change
-- volume). Droptop's real synced packages have NO financial_category data
-- at all (confirmed empty on every one of ~670k rows in production —
-- despite the field existing in Droptop's own API docs/webhook examples,
-- the batch get-orders sync never actually populates it for this
-- account), and there is no single package literally named "Oil Change"
-- either — real package names span at least 3 different naming eras
-- (canonical menu tiers, cryptic legacy SKU codes like SINS/EINS/FS2, and
-- "Xpress/PLUS/Early Bird Oil Change - <oil type>" variants). So
-- classification is by exact package NAME, keyed per company (not global)
-- since a franchise's naming could differ, and user-editable (not just
-- this migration's seed) so it stays correct as packages are renamed or
-- added — see the Package Mapping page (src/modules/customers/
-- PackageMappingPage.tsx), which lists every distinct package name ever
-- synced and lets an admin (re)classify any of them.
--
-- Only 3 buckets, not one per M5 sub-category — M5% itself is just
-- count(m5) / count(oil_change), it never needs to know WHICH of the 5 a
-- given package is.
CREATE TABLE IF NOT EXISTS inventory.droptop_package_classification (
  company_id     uuid        NOT NULL,
  package_name   text        NOT NULL,
  classification text        NOT NULL DEFAULT 'none' CHECK (classification IN ('oil_change', 'm5', 'none')),
  updated_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, package_name)
);

ALTER TABLE inventory.droptop_package_classification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "droptop_package_classification_select" ON inventory.droptop_package_classification;
CREATE POLICY "droptop_package_classification_select" ON inventory.droptop_package_classification FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
DROP POLICY IF EXISTS "droptop_package_classification_manage" ON inventory.droptop_package_classification;
CREATE POLICY "droptop_package_classification_manage" ON inventory.droptop_package_classification FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Seed the classifications confirmed against this account's real synced
-- package names (2026-09-30) — everything else defaults to 'none' until
-- reviewed on the Package Mapping page. Oil Change explicitly EXCLUDES
-- additive/top-off/flush/repair line items (Engine Oil Additive, Top off
-- Engine Oil, Complete Oil System Flush, drain-plug repairs, Diesel Oil
-- Conditioner, Engine Oil Evacuation) — those are add-ons, not the core
-- oil-change service itself.
INSERT INTO inventory.droptop_package_classification (company_id, package_name, classification)
SELECT DISTINCT l.company_id, v.package_name, v.classification
FROM core.locations l, (VALUES
  -- Canonical menu tiers
  ('Economy', 'oil_change'),
  ('Premium High Mileage', 'oil_change'),
  ('Premium Full Synthetic', 'oil_change'),
  ('Premium Full Synthetic High Mileage', 'oil_change'),
  -- Cryptic legacy SKU codes (high real volume, "FS"/"S"/"E" pattern strongly suggests Full Synthetic/Economy oil packages from a prior POS naming convention)
  ('SINS', 'oil_change'), ('EINS', 'oil_change'), ('FSDSYN', 'oil_change'), ('FS2', 'oil_change'),
  ('FSDB', 'oil_change'), ('FS3', 'oil_change'), ('FSE2', 'oil_change'), ('FFS', 'oil_change'),
  ('FS2D', 'oil_change'), ('FSE', 'oil_change'), ('FFS2', 'oil_change'),
  ('European Oil', 'oil_change'),
  -- "<Tier> Oil Change - <oil type>" naming era
  ('Xpress Oil Change - Better Oil', 'oil_change'), ('Xpress Oil Change - Best Oil (Mobil 1)', 'oil_change'),
  ('Xpress Oil Change - Best Oil (R&P)', 'oil_change'), ('Xpress Oil Change - Good Oil', 'oil_change'),
  ('Xpress Oil Change - Specialty Oil', 'oil_change'), ('Xpress Oil Change - Customer Supplied Oil', 'oil_change'),
  ('PLUS Oil Change - Better Oil', 'oil_change'), ('PLUS Oil Change - Best Oil (Mobil 1)', 'oil_change'),
  ('PLUS Oil Change - Best Oil (R&P)', 'oil_change'), ('PLUS Oil Change - Good Oil', 'oil_change'),
  ('PLUS Oil Change - Specialty Oil', 'oil_change'),
  ('Early Bird Xpress Oil Change - Better Oil', 'oil_change'), ('Early Bird Xpress Oil Change - Best Oil (Mobil 1)', 'oil_change'),
  ('Early Bird Xpress Oil Change - Best Oil (R&P)', 'oil_change'), ('Early Bird Xpress Oil Change - Good Oil', 'oil_change'),
  ('Early Bird Xpress Oil Change - Specialty Oil', 'oil_change'), ('Early Bird Xpress Oil Change - Customer Supplied Oil', 'oil_change'),
  ('DexosR Oil Change', 'oil_change'), ('Dexos Oil Change', 'oil_change'),
  -- M5 categories
  ('ENGINE AIR FILTER', 'm5'),
  ('CABIN AIR FILTER', 'm5'),
  ('WIPER BLADE REPLACEMENT', 'm5'), ('Wiper Blade Replacement', 'm5'),
  ('Additives', 'm5'),
  ('Tire Rotation', 'm5')
) AS v(package_name, classification)
ON CONFLICT (company_id, package_name) DO NOTHING;

-- Every distinct package name ever synced, with how often it's shown up
-- (helps an admin judge an unfamiliar/cryptic name's real volume before
-- classifying it) — one grouped query server-side rather than pulling
-- every droptop_order_packages row (670k+) to the client just to dedupe
-- names client-side, which would also silently truncate at PostgREST's
-- row cap and undercount. Confirmed via EXPLAIN ANALYZE: ~1.2s for the
-- full scan, since the actual RESULT is only ~80-100 distinct names
-- regardless of how many order-package rows exist. SECURITY INVOKER, same
-- reasoning as get_droptop_order_month_stats — the caller's own RLS on
-- droptop_order_packages applies, no company_id argument needed or trusted.
CREATE OR REPLACE FUNCTION public.get_droptop_package_name_counts()
RETURNS TABLE (name text, order_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT p.name, count(*) AS order_count
  FROM inventory.droptop_order_packages p
  WHERE p.name IS NOT NULL
  GROUP BY p.name
$$;

GRANT EXECUTE ON FUNCTION public.get_droptop_package_name_counts() TO authenticated;
