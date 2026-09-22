-- Backs the new on-hand plausibility check (2026-09-22 request): given a
-- set of (location_id, product_id, delivery_date) triples — one per line
-- that has a known RelaDyne delivery — returns the on-hand snapshot at (or
-- just before) that delivery date and everything sold since, both from
-- inventory.daily_product_activity's own day-by-day ledger. The actual
-- "is the on-hand plausible" math (expected = on_hand_at_delivery +
-- delivered_qty - sold_since_delivery, tolerance = ±N days of usage)
-- happens client-side in onHandCheck.ts, since it also needs the
-- delivered qty (RD-sourced) and today's live usage/on-hand (already on
-- the draft line) — this RPC only supplies the two numbers that live
-- exclusively in the daily ledger.
--
-- Takes a JSON array of {location_id, product_id, delivery_date} objects
-- (built client-side from whatever's on screen) rather than three parallel
-- arrays — same jsonb_array_elements pattern already used elsewhere in
-- this project for a caller-supplied set of rows.
--
-- on_hand_at_delivery uses the most recent snapshot AT OR BEFORE the
-- delivery date, not an exact match — the daily sync doesn't necessarily
-- have a row for every single calendar day for every product, so an exact
-- match would silently return nothing for a delivery date that happened to
-- fall on a gap. sold_since_delivery sums everything strictly AFTER that
-- date through whatever's currently in the table (effectively "through
-- today," since this table is kept current).
CREATE OR REPLACE FUNCTION public.get_ov2_on_hand_check_data(p_pairs jsonb)
RETURNS TABLE (
  location_id uuid, product_id text, delivery_date date,
  on_hand_at_delivery numeric, sold_since_delivery numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  WITH pairs AS (
    SELECT
      (p->>'location_id')::uuid AS location_id,
      (p->>'product_id')::text AS product_id,
      (p->>'delivery_date')::date AS delivery_date
    FROM jsonb_array_elements(p_pairs) AS p
  )
  SELECT
    pr.location_id, pr.product_id, pr.delivery_date,
    (SELECT a.ending_on_hand FROM inventory.daily_product_activity a
       WHERE a.company_id = get_my_company_id() AND a.location_id = pr.location_id AND a.product_id = pr.product_id
         AND a.activity_date <= pr.delivery_date AND a.ending_on_hand IS NOT NULL
       ORDER BY a.activity_date DESC LIMIT 1) AS on_hand_at_delivery,
    (SELECT sum(a.sold_qty) FROM inventory.daily_product_activity a
       WHERE a.company_id = get_my_company_id() AND a.location_id = pr.location_id AND a.product_id = pr.product_id
         AND a.activity_date > pr.delivery_date) AS sold_since_delivery
  FROM pairs pr
$$;
