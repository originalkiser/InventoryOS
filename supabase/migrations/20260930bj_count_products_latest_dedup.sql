-- Real bug found live 2026-09-24: inventory.count_products is meant to
-- hold ONE current snapshot per (location_id, product_id) per count_month
-- — droptop-sync-usage's own header comment says so explicitly ("delete-
-- then-insert, not additive... summing two same-day pulls would double
-- it"), replacing the prior day's rows under the same reused upload_batch
-- each time it runs. But that delete's own result was never checked (see
-- the droptop-sync-usage fix alongside this migration), so a silent
-- failure left old rows sitting alongside new ones — confirmed live: shop
-- 159-Sylva had the same oil products duplicated across 2-4 separate
-- days under the SAME batch id, each contributing its own on_hand/
-- ending_value.
--
-- Neither of the two RPCs that read "current" totals filtered down to
-- just the latest row per product before summing — both blindly summed
-- EVERY accumulated day. Reported symptom: a shop's live oil $ value (the
-- Expected Oil Balance recount check) reading ~2.2x its real Droptop
-- value; the same underlying bug also inflates the Month End Overview
-- page's own live Oil/Parts/Additives/Total KPIs for the current
-- (still-open) period, since get_current_balance_by_category reads the
-- exact same table the exact same (buggy) way.
--
-- Fixed by de-duplicating to the latest row per (location_id, product_id)
-- — by created_at, since a later Droptop pull for the same product always
-- represents a more current on-hand reading — BEFORE joining/aggregating,
-- in both functions. This is a read-side safety net independent of
-- whether the write-side delete is ever imperfect again (a defensive
-- "latest snapshot" query should never trust that upstream writes were
-- perfectly clean) — the write-side fix (checking the delete's error) is
-- what stops NEW accumulation; this is what makes today's read correct
-- regardless of what's already sitting in the table from before that fix.
CREATE OR REPLACE FUNCTION public.get_current_oil_on_hand_value(p_company_id uuid, p_count_month date)
RETURNS TABLE (location_id uuid, oil_value numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (cp.location_id, cp.product_id)
      cp.location_id, cp.product_id, cp.category, cp.on_hand
    FROM inventory.count_products cp
    WHERE cp.company_id = p_company_id AND cp.count_month = p_count_month
      AND cp.location_id IS NOT NULL AND cp.on_hand IS NOT NULL
    ORDER BY cp.location_id, cp.product_id, cp.created_at DESC
  )
  SELECT l.location_id, sum((l.on_hand / 4.0) * vp.price_per_gallon) AS oil_value
  FROM latest l
  JOIN inventory.category_simplification cs
    ON cs.company_id = p_company_id AND cs.category = l.category AND cs.simple_category = 'Oil'
  JOIN LATERAL (
    SELECT (v.metadata->>'price_per_gallon')::numeric AS price_per_gallon
    FROM inventory.vendor_parts v
    WHERE v.company_id = p_company_id AND lower(v.our_part_number) = lower(l.product_id)
      AND (v.metadata->>'price_per_gallon') IS NOT NULL
    LIMIT 1
  ) vp ON true
  GROUP BY l.location_id
$$;

CREATE OR REPLACE FUNCTION public.get_current_balance_by_category(p_company_id uuid, p_count_month date)
RETURNS TABLE (location_id uuid, oil numeric, parts numeric, additives numeric, other numeric, total numeric)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (cp.location_id, cp.product_id)
      cp.location_id, cp.product_id, cp.category, cp.ending_value
    FROM inventory.count_products cp
    WHERE cp.company_id = p_company_id AND cp.count_month = p_count_month
      AND cp.location_id IS NOT NULL AND cp.ending_value IS NOT NULL
    ORDER BY cp.location_id, cp.product_id, cp.created_at DESC
  )
  SELECT
    l.location_id,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Oil') AS oil,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Parts') AS parts,
    sum(l.ending_value) FILTER (WHERE cs.simple_category = 'Additives') AS additives,
    sum(l.ending_value) FILTER (
      WHERE cs.simple_category IS NULL OR cs.simple_category NOT IN ('Oil', 'Parts', 'Additives')
    ) AS other,
    sum(l.ending_value) AS total
  FROM latest l
  LEFT JOIN inventory.category_simplification cs
    ON cs.company_id = p_company_id AND cs.category = l.category
  GROUP BY l.location_id
$$;
