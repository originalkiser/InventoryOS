-- Expected Oil Balance (2026-09-22 request) — Finance's own modeled
-- ending balance for oil (from starting balance + bills + amount sold),
-- uploaded per shop per period. Bills are usually lagged, so a real shop
-- balance is normally HIGHER than Finance's own model — the useful signal
-- is when actual on-hand comes in meaningfully LOWER, which suggests the
-- shop was billed for oil that never showed up in inventory. Separate,
-- simple per-(shop, period) value — not an additive batch log like
-- count_products, since a re-upload for the same period should just
-- replace the prior value.
CREATE TABLE inventory.expected_oil_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  location_id uuid NOT NULL,
  count_month date NOT NULL,
  expected_balance numeric NOT NULL,
  uploaded_by uuid,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, location_id, count_month)
);

ALTER TABLE inventory.expected_oil_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Company members manage expected_oil_balances" ON inventory.expected_oil_balances
  FOR ALL USING (company_id = get_my_company_id()) WITH CHECK (company_id = get_my_company_id());

CREATE INDEX idx_expected_oil_balances_period ON inventory.expected_oil_balances (company_id, count_month);

-- The recount rule's own threshold — separate column from the existing
-- low/high pair since this compares against a per-shop uploaded target,
-- not a fixed number or the shop's own history. NULL/blank = off, same
-- "blank = off" convention as every other recount_config threshold.
ALTER TABLE inventory.recount_config ADD COLUMN IF NOT EXISTS oil_balance_threshold numeric;

-- Live current-period oil $ value from what's actually on hand right now
-- (inventory.count_products, fed daily by the Droptop pull during
-- month-end — see OverviewTab.tsx's own comment on this same data source)
-- — not the manually-entered monthly_ending_balances, which normally only
-- gets a row once the month closes and would defeat the whole point of
-- catching this DURING the month. "Oil" categories are whichever raw
-- count_products.category values this company has mapped to the 'Oil'
-- simplified bucket in inventory.category_simplification (Config ->
-- Category Simplification) — not hardcoded to 'Engine Oil', since that
-- mapping is already company-configurable and this should agree with it.
--
-- Valued via inventory.vendor_parts.metadata->>'price_per_gallon' (the
-- same per-gallon cost Orders v2's own engine already uses for RelaDyne/
-- Valvoline bulk pricing — confirmed live: 68 of 68 vendor_parts rows
-- have this set) — on_hand is assumed to be in quarts (this app's
-- internal convention for oil elsewhere; a product tracked in a different
-- unit, e.g. HM0806's ounces, isn't specially converted here since this is
-- a recount-flagging estimate, not a final accounting figure). A product
-- with no matching vendor_parts price is simply excluded from the total
-- (better to undercount than to silently treat a missing price as $0 and
-- imply "over-balance").
CREATE OR REPLACE FUNCTION public.get_current_oil_on_hand_value(p_company_id uuid, p_count_month date)
RETURNS TABLE (location_id uuid, oil_value numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT cp.location_id, sum((cp.on_hand / 4.0) * vp.price_per_gallon) AS oil_value
  FROM inventory.count_products cp
  JOIN inventory.category_simplification cs
    ON cs.company_id = cp.company_id AND cs.category = cp.category AND cs.simple_category = 'Oil'
  JOIN LATERAL (
    SELECT (v.metadata->>'price_per_gallon')::numeric AS price_per_gallon
    FROM inventory.vendor_parts v
    WHERE v.company_id = cp.company_id AND lower(v.our_part_number) = lower(cp.product_id)
      AND (v.metadata->>'price_per_gallon') IS NOT NULL
    LIMIT 1
  ) vp ON true
  WHERE cp.company_id = p_company_id AND cp.count_month = p_count_month
    AND cp.location_id IS NOT NULL AND cp.on_hand IS NOT NULL
  GROUP BY cp.location_id
$$;
