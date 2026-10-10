-- Home page chart cards. All SECURITY INVOKER (RLS applies).

-- Configured products (shop x product in order config) sitting at zero on hand, per product.
CREATE OR REPLACE FUNCTION inventory.get_home_zero_on_hand_by_product()
RETURNS TABLE(product_id text, shops_at_zero int, shops_configured int)
LANGUAGE sql STABLE SECURITY INVOKER SET statement_timeout = '30s' AS $$
  SELECT c.product_id::text,
         count(*) FILTER (WHERE u.id IS NOT NULL AND coalesce(u.on_hands, 0) <= 0)::int,
         count(*)::int
  FROM inventory.location_order_config c
  JOIN core.locations l ON l.id = c.location_id AND l.active
  LEFT JOIN inventory.product_usage u ON u.location_id = c.location_id AND u.product_id = c.product_id
  WHERE c.active IS NOT FALSE
  GROUP BY c.product_id
  ORDER BY 2 DESC, 3 DESC
$$;

-- Gallons per order unit from a RelaDyne vendor_parts unit_of_measure: BULK = 1, DRUM = 55, "6/G BX" = 6, "12/1 Q CS" = 3.
CREATE OR REPLACE FUNCTION inventory.uom_gallons_per_unit(p_uom text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN upper(trim(p_uom)) = 'BULK' THEN 1
    WHEN upper(trim(p_uom)) = 'DRUM' THEN 55
    WHEN upper(trim(p_uom)) ~ '^[0-9]+/G' THEN substring(upper(trim(p_uom)) from '^([0-9]+)/G')::numeric
    WHEN upper(trim(p_uom)) ~ '^[0-9]+/1 ?Q' THEN substring(upper(trim(p_uom)) from '^([0-9]+)/1')::numeric / 4
    ELSE NULL END
$$;

-- Sold (Droptop usage ledger, quarts -> gallons) vs ordered (RelaDyne open order report) per product over a date range.
CREATE OR REPLACE FUNCTION inventory.get_home_sold_vs_ordered(p_start date, p_end date)
RETURNS TABLE(product_id text, sold_gal numeric, ordered_gal numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET statement_timeout = '30s' AS $$
  WITH parts AS (
    SELECT DISTINCT ON (our_part_number, part_number) our_part_number, part_number, unit_of_measure
    FROM inventory.vendor_parts WHERE our_part_number IS NOT NULL
  ),
  sold AS (
    SELECT a.product_id, sum(a.sold_qty) / 4.0 AS g
    FROM inventory.daily_product_activity a
    WHERE a.activity_date BETWEEN p_start AND p_end AND a.product_id IN (SELECT our_part_number FROM parts)
    GROUP BY a.product_id
  ),
  ord AS (
    SELECT p.our_part_number AS pid, sum(o.qty_ordered::numeric * coalesce(inventory.uom_gallons_per_unit(p.unit_of_measure), 0)) AS g
    FROM inventory.rd_open_orders o JOIN parts p ON p.part_number = o.product_code
    WHERE o.order_date BETWEEN p_start AND p_end
    GROUP BY p.our_part_number
  )
  SELECT coalesce(s.product_id, o.pid)::text, round(coalesce(s.g, 0), 1), round(coalesce(o.g, 0), 1)
  FROM sold s FULL JOIN ord o ON o.pid = s.product_id
  ORDER BY coalesce(s.g, 0) DESC
$$;

-- Gallons placed through Orders v2 per product (history lines) over a date range.
CREATE OR REPLACE FUNCTION inventory.get_home_gallons_ordered(p_start date, p_end date)
RETURNS TABLE(product_id text, gallons numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET statement_timeout = '30s' AS $$
  SELECT l.product_id::text, round(sum(l.qty * coalesce(l.quarts_per_unit, 0)) / 4.0, 1)
  FROM inventory.ov2_order_history_lines l
  JOIN inventory.ov2_order_history h ON h.id = l.order_id
  WHERE h.order_date BETWEEN p_start AND p_end
  GROUP BY l.product_id
  HAVING sum(l.qty * coalesce(l.quarts_per_unit, 0)) > 0
  ORDER BY 2 DESC
$$;
