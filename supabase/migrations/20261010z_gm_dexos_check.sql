-- GM Warranty & Dexos Oil Check (Droptop sidebar section, route /gm-dexos-check).
--
-- Goal: GM vehicles still in warranty (young AND low mileage) should be serviced
-- with a GM Dexos-approved oil. This file adds:
--   1. inventory.gm_dexos_location_tz()  - helper (SECURITY DEFINER) exposing the
--      company's shop -> timezone map. inventory.location_timezones has RLS on and
--      no authenticated grant, so the INVOKER report functions below cannot read it
--      directly. Scoped to the caller's own company through core.locations.
--   2. inventory.get_gm_dexos_summary()  - per shop + month counts of DISTINCT
--      vehicles in each bucket (the page's automatic, server-side aggregate).
--   3. inventory.get_gm_dexos_detail()   - paginated order-level detail behind a
--      shop-month (or one bucket of it), loaded on demand by a button.
--
-- Local dates: same rule as inventory.refresh_order_rollups -
-- (order_finalized_at AT TIME ZONE shop tz)::date, Void orders excluded.
--
-- Product matching ("uses Dexos"): a product id on ANY service of the order counts
-- when it equals an approved id or an approved id plus a 1-3 letter case-type suffix
-- (D = drum, BB = bay box, C = case ...), e.g. DEXOS-SYN-5W30 matches
-- DEXOS-SYN-5W30D / DEXOS-SYN-5W30BB.
--
-- Vehicle buckets (per distinct vehicle per shop-month):
--   gm_warranty_dexos   GM make, age < p_max_age_years AND miles < p_max_miles, used an approved oil
--   gm_warranty_miss    GM make, in warranty by the same test, NO approved oil (the compliance miss)
--   gm_out_of_warranty  GM make, known year + mileage, age >= years OR miles >= miles
--   gm_unknown          GM make but model year or mileage missing/zero (cannot be judged)
--   nongm_dexos / nongm_no_dexos   any other make (incl. unknown make), used / did not use approved oil
-- Age = year of the (shop-local) service date - model year (vin_vehicle_year).

CREATE OR REPLACE FUNCTION inventory.gm_dexos_location_tz()
RETURNS TABLE(location_id uuid, tz text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'inventory', 'core', 'pg_temp'
AS $$
  SELECT lt.location_id, lt.tz
    FROM inventory.location_timezones lt
    JOIN core.locations l ON l.id = lt.location_id
   WHERE l.company_id = public.get_my_company_id();
$$;

REVOKE ALL ON FUNCTION inventory.gm_dexos_location_tz() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory.gm_dexos_location_tz() TO authenticated;

-- Orders (all time, company-scoped) containing any of the given product probes
-- ('[{"product_id":"X"}]' jsonb arrays). A separate SECURITY DEFINER helper with
-- enable_seqscan off: under the caller's RLS the planner mis-estimated the match
-- count for products @> ANY(...) and chose a 30s sequential scan of the 6M-row
-- services table over the GIN index (8s cold / <1s warm). Company scoping is
-- explicit here instead of via RLS.
CREATE OR REPLACE FUNCTION inventory.gm_dexos_order_ids(p_probes jsonb[])
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'inventory', 'pg_temp'
SET enable_seqscan TO off
AS $$
  SELECT DISTINCT s.order_id
    FROM inventory.droptop_order_services s
   WHERE s.products @> ANY (p_probes)
     AND s.company_id = public.get_my_company_id();
$$;

REVOKE ALL ON FUNCTION inventory.gm_dexos_order_ids(jsonb[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory.gm_dexos_order_ids(jsonb[]) TO authenticated;

-- --------------------------------------------------------------------------
DROP FUNCTION IF EXISTS inventory.get_gm_dexos_summary(date, date, uuid[], numeric, numeric, text[], text[]);

CREATE OR REPLACE FUNCTION inventory.get_gm_dexos_summary(
  p_start date,
  p_end date,
  p_location_ids uuid[] DEFAULT NULL,
  p_max_age_years numeric DEFAULT 5,
  p_max_miles numeric DEFAULT 60000,
  p_approved_ids text[] DEFAULT ARRAY['DEXOS-SYN-5W30','DEXOS-SYN-0W20','0W40-MBL1-DEXOSR'],
  p_gm_makes text[] DEFAULT ARRAY['Chevrolet','GMC','Buick','Cadillac']
)
RETURNS TABLE(
  location_id uuid,
  month date,
  total_vehicles bigint,
  total_orders bigint,
  gm_warranty_dexos bigint,
  gm_warranty_miss bigint,
  gm_out_of_warranty bigint,
  gm_unknown bigint,
  nongm_dexos bigint,
  nongm_no_dexos bigint
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'inventory', 'pg_temp'
SET statement_timeout TO '60s'
SET work_mem TO '64MB'
SET plan_cache_mode TO 'force_custom_plan'
AS $$
DECLARE
  v_re text;
  v_gm text[];
  v_probes jsonb[];
  v_from timestamptz := p_start::timestamp AT TIME ZONE 'UTC';
  v_to timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours';
BEGIN
  SELECT '^(' || string_agg(regexp_replace(upper(trim(a)), '([.^$|()\[\]{}*+?\\-])', '\\\1', 'g'), '|') || ')[A-Z]{0,3}$'
    INTO v_re
    FROM unnest(coalesce(p_approved_ids, ARRAY[]::text[])) a
   WHERE trim(coalesce(a, '')) <> '';
  IF v_re IS NULL THEN v_re := 'a^'; END IF;  -- no approved ids: matches nothing

  SELECT coalesce(array_agg(lower(trim(m))), ARRAY[]::text[]) INTO v_gm
    FROM unnest(coalesce(p_gm_makes, ARRAY[]::text[])) m WHERE trim(coalesce(m, '')) <> '';

  -- Every real product id (approved ids + their case-type variants) is resolved up
  -- front from inventory.product_usage (trigram-indexed, ~50ms; the daily product
  -- rollup took ~9s to scan for the same answer), then probed through the GIN index on
  -- droptop_order_services.products - reading the 6M-row services table for every
  -- order in the month is what made this slow (~77s vs ~10s).
  SELECT coalesce(array_agg(jsonb_build_array(jsonb_build_object('product_id', pid))), ARRAY[]::jsonb[])
    INTO v_probes
    FROM (SELECT DISTINCT r.product_id AS pid
            FROM product_usage r
           WHERE r.product_id ~* v_re
          UNION
          SELECT trim(a) FROM unnest(coalesce(p_approved_ids, ARRAY[]::text[])) a WHERE trim(coalesce(a, '')) <> '') ids;

  RETURN QUERY
  WITH tz AS (
    SELECT t.location_id, t.tz FROM inventory.gm_dexos_location_tz() t
  ),
  dx AS MATERIALIZED (
    SELECT o AS order_id FROM inventory.gm_dexos_order_ids(v_probes) o
  ),
  ord AS (
    SELECT o.id, o.location_id, o.customer_id, o.first_name, o.last_name,
           (o.order_finalized_at AT TIME ZONE t.tz)::date AS d
      FROM droptop_orders o
      JOIN tz t ON t.location_id = o.location_id
     WHERE o.order_finalized_at >= v_from AND o.order_finalized_at < v_to
       AND o.status IS DISTINCT FROM 'Void'
       AND (p_location_ids IS NULL OR o.location_id = ANY(p_location_ids))
  ),
  x AS (
    SELECT ord.location_id, date_trunc('month', ord.d)::date AS m, ord.d, ord.id AS order_id,
           coalesce(nullif(trim(v.vin), ''),
                    lower(concat_ws('|', v.vin_vehicle_make, v.vin_vehicle_model, v.vin_vehicle_year::text,
                                    coalesce(ord.customer_id, ord.first_name || ' ' || ord.last_name)))) AS vkey,
           (lower(trim(coalesce(v.vin_vehicle_make, ''))) = ANY(v_gm)) AS is_gm,
           CASE WHEN v.vin_vehicle_year IS NULL OR v.mileage IS NULL OR v.mileage <= 0 THEN 'U'
                WHEN (extract(year FROM ord.d) - v.vin_vehicle_year) < p_max_age_years
                     AND v.mileage < p_max_miles THEN 'W'
                ELSE 'O' END AS wstat,
           v.mileage,
           (dx.order_id IS NOT NULL) AS dex
      FROM ord
      JOIN droptop_order_vehicles v ON v.order_id = ord.id
      LEFT JOIN dx ON dx.order_id = ord.id
     WHERE ord.d BETWEEN p_start AND p_end
  ),
  veh AS (
    SELECT x.location_id, x.m, x.vkey,
           bool_or(x.is_gm) AS is_gm,
           (array_agg(x.wstat ORDER BY x.d DESC, x.mileage DESC NULLS LAST))[1] AS wstat,
           bool_or(x.dex) AS dex,
           count(DISTINCT x.order_id) AS orders
      FROM x
     GROUP BY x.location_id, x.m, x.vkey
  )
  SELECT veh.location_id, veh.m,
         count(*)::bigint,
         sum(veh.orders)::bigint,
         count(*) FILTER (WHERE veh.is_gm AND veh.wstat = 'W' AND veh.dex)::bigint,
         count(*) FILTER (WHERE veh.is_gm AND veh.wstat = 'W' AND NOT veh.dex)::bigint,
         count(*) FILTER (WHERE veh.is_gm AND veh.wstat = 'O')::bigint,
         count(*) FILTER (WHERE veh.is_gm AND veh.wstat = 'U')::bigint,
         count(*) FILTER (WHERE NOT veh.is_gm AND veh.dex)::bigint,
         count(*) FILTER (WHERE NOT veh.is_gm AND NOT veh.dex)::bigint
    FROM veh
   GROUP BY veh.location_id, veh.m
   ORDER BY veh.m, veh.location_id;
END;
$$;

GRANT EXECUTE ON FUNCTION inventory.get_gm_dexos_summary(date, date, uuid[], numeric, numeric, text[], text[]) TO authenticated;

-- --------------------------------------------------------------------------
-- Order-level detail for one shop. p_bucket NULL = every order; otherwise one of
-- gm_warranty_dexos / gm_warranty_miss / gm_out_of_warranty / gm_unknown /
-- nongm_dexos / nongm_no_dexos. Classification here is per ORDER (the summary is
-- per distinct vehicle per month, so a vehicle serviced twice shows two rows).
DROP FUNCTION IF EXISTS inventory.get_gm_dexos_detail(date, date, uuid, text, numeric, numeric, text[], text[], int, int);

CREATE OR REPLACE FUNCTION inventory.get_gm_dexos_detail(
  p_start date,
  p_end date,
  p_location_id uuid,
  p_bucket text DEFAULT NULL,
  p_max_age_years numeric DEFAULT 5,
  p_max_miles numeric DEFAULT 60000,
  p_approved_ids text[] DEFAULT ARRAY['DEXOS-SYN-5W30','DEXOS-SYN-0W20','0W40-MBL1-DEXOSR'],
  p_gm_makes text[] DEFAULT ARRAY['Chevrolet','GMC','Buick','Cadillac'],
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  total_count bigint,
  order_id text,
  order_date date,
  location_id uuid,
  vin text,
  vehicle_year int,
  vehicle_make text,
  vehicle_model text,
  mileage numeric,
  packages text,
  oil_product_ids text,
  uses_dexos boolean,
  bucket text
)
LANGUAGE plpgsql
STABLE
SET search_path TO 'inventory', 'pg_temp'
SET statement_timeout TO '60s'
SET work_mem TO '64MB'
SET plan_cache_mode TO 'force_custom_plan'
AS $$
DECLARE
  v_re text;
  v_gm text[];
  v_from timestamptz := p_start::timestamp AT TIME ZONE 'UTC';
  v_to timestamptz := (p_end + 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours';
BEGIN
  SELECT '^(' || string_agg(regexp_replace(upper(trim(a)), '([.^$|()\[\]{}*+?\\-])', '\\\1', 'g'), '|') || ')[A-Z]{0,3}$'
    INTO v_re
    FROM unnest(coalesce(p_approved_ids, ARRAY[]::text[])) a
   WHERE trim(coalesce(a, '')) <> '';
  IF v_re IS NULL THEN v_re := 'a^'; END IF;

  SELECT coalesce(array_agg(lower(trim(m))), ARRAY[]::text[]) INTO v_gm
    FROM unnest(coalesce(p_gm_makes, ARRAY[]::text[])) m WHERE trim(coalesce(m, '')) <> '';

  RETURN QUERY
  WITH tz AS (
    SELECT t.location_id, t.tz FROM inventory.gm_dexos_location_tz() t WHERE t.location_id = p_location_id
  ),
  ord AS (
    SELECT o.id, o.order_id AS order_no, o.location_id,
           (o.order_finalized_at AT TIME ZONE t.tz)::date AS d
      FROM droptop_orders o
      JOIN tz t ON t.location_id = o.location_id
     WHERE o.order_finalized_at >= v_from AND o.order_finalized_at < v_to
       AND o.status IS DISTINCT FROM 'Void'
       AND o.location_id = p_location_id
  ),
  x AS (
    SELECT ord.id, ord.order_no, ord.location_id, ord.d,
           v.vin, v.vin_vehicle_year AS yr, v.vin_vehicle_make AS mk, v.vin_vehicle_model AS md, v.mileage,
           (lower(trim(coalesce(v.vin_vehicle_make, ''))) = ANY(v_gm)) AS is_gm,
           CASE WHEN v.vin_vehicle_year IS NULL OR v.mileage IS NULL OR v.mileage <= 0 THEN 'U'
                WHEN (extract(year FROM ord.d) - v.vin_vehicle_year) < p_max_age_years
                     AND v.mileage < p_max_miles THEN 'W'
                ELSE 'O' END AS wstat,
           (SELECT string_agg(DISTINCT e ->> 'product_id', ', ')
              FROM droptop_order_services s
             CROSS JOIN LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof(s.products) = 'array' THEN s.products ELSE '[]'::jsonb END) e
             WHERE s.order_id = ord.id AND (e ->> 'product_type') = 'Engine Oil') AS oils,
           EXISTS (SELECT 1
                     FROM droptop_order_services s
                    CROSS JOIN LATERAL jsonb_array_elements(
                          CASE WHEN jsonb_typeof(s.products) = 'array' THEN s.products ELSE '[]'::jsonb END) e
                    WHERE s.order_id = ord.id AND (e ->> 'product_id') ~* v_re) AS dex
      FROM ord
      JOIN droptop_order_vehicles v ON v.order_id = ord.id
     WHERE ord.d BETWEEN p_start AND p_end
  ),
  b AS (
    SELECT x.*,
           CASE WHEN x.is_gm AND x.wstat = 'W' AND x.dex THEN 'gm_warranty_dexos'
                WHEN x.is_gm AND x.wstat = 'W' THEN 'gm_warranty_miss'
                WHEN x.is_gm AND x.wstat = 'O' THEN 'gm_out_of_warranty'
                WHEN x.is_gm THEN 'gm_unknown'
                WHEN x.dex THEN 'nongm_dexos'
                ELSE 'nongm_no_dexos' END AS bucket
      FROM x
  ),
  f AS (
    SELECT * FROM b WHERE p_bucket IS NULL OR b.bucket = p_bucket
  ),
  pg AS (
    SELECT f.*, count(*) OVER () AS total
      FROM f
     ORDER BY f.d DESC, f.order_no
     LIMIT greatest(p_limit, 1) OFFSET greatest(p_offset, 0)
  )
  SELECT pg.total::bigint, pg.order_no, pg.d, pg.location_id, pg.vin, pg.yr, pg.mk, pg.md, pg.mileage,
         (SELECT string_agg(DISTINCT p.name, ', ') FROM droptop_order_packages p WHERE p.order_id = pg.id),
         pg.oils, pg.dex, pg.bucket
    FROM pg
   ORDER BY pg.d DESC, pg.order_no;
END;
$$;

GRANT EXECUTE ON FUNCTION inventory.get_gm_dexos_detail(date, date, uuid, text, numeric, numeric, text[], text[], int, int) TO authenticated;
