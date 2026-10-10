-- Per-shop oil-change / M5 / quart totals from the daily rollups (Droptop Orders' By Shop table: M5% and avg quarts per oil change).
CREATE OR REPLACE FUNCTION inventory.get_orders_shop_stats(p_start date, p_end date, p_location_ids uuid[] DEFAULT NULL, p_vehicle_makes text[] DEFAULT NULL)
RETURNS TABLE(location_id uuid, oil_packages bigint, m5_packages bigint, quarts numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = inventory, pg_temp SET work_mem = '32MB' SET statement_timeout = '60s' AS $$
  WITH cls AS (SELECT package_name, classification FROM inventory.droptop_package_classification),
  pk AS (
    SELECT r.location_id,
           sum(r.packages_sold) FILTER (WHERE c.classification = 'oil_change') AS oil,
           sum(r.packages_sold) FILTER (WHERE c.classification IN ('air_filter','cabin_air_filter','wiper_blades','additives','tire_rotation')) AS m5
    FROM rollup_packages_daily r JOIN cls c ON c.package_name = r.package_name
    WHERE r.order_date BETWEEN p_start AND p_end
      AND (p_location_ids IS NULL OR r.location_id = ANY(p_location_ids))
      AND (p_vehicle_makes IS NULL OR r.vehicle_make = ANY(p_vehicle_makes))
    GROUP BY r.location_id
  ),
  pr AS (
    SELECT r.location_id, sum(r.quantity) FILTER (WHERE upper(trim(r.uom)) = 'QT') AS qts
    FROM rollup_products_daily r
    WHERE r.order_date BETWEEN p_start AND p_end
      AND (p_location_ids IS NULL OR r.location_id = ANY(p_location_ids))
      AND (p_vehicle_makes IS NULL OR r.vehicle_make = ANY(p_vehicle_makes))
    GROUP BY r.location_id
  )
  SELECT coalesce(pk.location_id, pr.location_id), coalesce(pk.oil, 0)::bigint, coalesce(pk.m5, 0)::bigint, coalesce(pr.qts, 0)
  FROM pk FULL JOIN pr ON pr.location_id = pk.location_id
$$;
