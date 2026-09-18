-- Droptop pricing audit (2026-09-19 follow-up) — Droptop Orders' own
-- base_service_price (added 2026-09-17, see DroptopOrdersPage.tsx) lets us
-- audit whether what's actually being sold in Droptop matches the pricing
-- we have listed for that shop. This only makes sense for OIL CHANGE
-- packages specifically (the other classifications — M5 sub-categories —
-- aren't priced columns on core.locations at all), so a package's own
-- classification row (inventory.droptop_package_classification) now also
-- carries which of the 5 canonical core.locations price columns it maps
-- to, when it's an oil-change package. Multiple raw Droptop package names
-- (across the app's 3 documented naming eras) can map to the same column
-- for the same shop — the audit groups by (shop, price_column), not by
-- raw name, since that's the actual comparison target.
ALTER TABLE inventory.droptop_package_classification
  ADD COLUMN price_column text
    CHECK (price_column IS NULL OR price_column IN ('economy', 'premium_hm', 'premium_full_synthetic', 'premium_full_synthetic_hm', 'rp'));

-- Per-shop, per-package "what's actually being sold" for the last N days
-- (default 7 = "last week"), one row per (location_id, package_name) so the
-- Packages page can show the raw picture for every package (not just oil
-- change, per the explicit ask to have "all the packages in there"), while
-- price_column/mode-vs-list comparison only ever applies to oil-change rows
-- that have one mapped. mode_price is whichever base_service_price showed
-- up most often in the window (ties broken by lowest price, arbitrary but
-- deterministic); distinct_price_count > 1 is the "multiple prices seen"
-- callout trigger. SECURITY INVOKER (the default — no DEFINER needed) since
-- an authenticated admin's own RLS on droptop_order_packages/droptop_orders
-- already scopes this to their own company, same shape as
-- get_droptop_package_name_counts().
CREATE OR REPLACE FUNCTION public.get_droptop_package_price_audit(p_days int DEFAULT 7)
RETURNS TABLE (
  location_id uuid,
  package_name text,
  classification text,
  price_column text,
  mode_price numeric,
  mode_count bigint,
  total_count bigint,
  distinct_price_count int
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT o.location_id, p.name AS package_name, p.base_service_price
    FROM inventory.droptop_order_packages p
    JOIN inventory.droptop_orders o ON o.id = p.order_id
    WHERE p.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
      AND o.order_finalized_at >= now() - (p_days || ' days')::interval
      AND p.base_service_price IS NOT NULL
  ),
  counted AS (
    SELECT location_id, package_name, base_service_price, count(*) AS cnt
    FROM scoped
    GROUP BY location_id, package_name, base_service_price
  ),
  agg AS (
    SELECT
      location_id, package_name,
      sum(cnt) AS total_count,
      count(*)::int AS distinct_price_count,
      (array_agg(base_service_price ORDER BY cnt DESC, base_service_price ASC))[1] AS mode_price,
      (array_agg(cnt ORDER BY cnt DESC, base_service_price ASC))[1] AS mode_count
    FROM counted
    GROUP BY location_id, package_name
  )
  SELECT
    a.location_id, a.package_name,
    COALESCE(c.classification, 'none') AS classification,
    c.price_column,
    a.mode_price, a.mode_count, a.total_count, a.distinct_price_count
  FROM agg a
  LEFT JOIN inventory.droptop_package_classification c
    ON c.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND c.package_name = a.package_name;
$function$;

GRANT EXECUTE ON FUNCTION public.get_droptop_package_price_audit(int) TO authenticated;

-- Drill-down for the "multiple prices seen" callout — every order in the
-- window for that exact (shop, package name) pair, newest first.
CREATE OR REPLACE FUNCTION public.get_droptop_package_price_audit_orders(p_location_id uuid, p_package_name text, p_days int DEFAULT 7)
RETURNS TABLE (
  order_id uuid,
  order_finalized_at timestamptz,
  base_service_price numeric,
  vehicle_name text,
  license_plate text
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT o.id, o.order_finalized_at, p.base_service_price, p.vehicle_name, p.license_plate
  FROM inventory.droptop_order_packages p
  JOIN inventory.droptop_orders o ON o.id = p.order_id
  WHERE p.company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND o.location_id = p_location_id
    AND p.name = p_package_name
    AND o.order_finalized_at >= now() - (p_days || ' days')::interval
  ORDER BY o.order_finalized_at DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_droptop_package_price_audit_orders(uuid, text, int) TO authenticated;
