-- Product Sales History: a precomputed monthly (shop, product) sales summary
-- so the page's default view no longer has to re-run the expensive live
-- join (get_droptop_order_product_sales, migration 20260930l) that's been
-- timing out. Confirmed via EXPLAIN ANALYZE against production (2026-09-29):
-- one month's worth of that join (droptop_orders + droptop_order_services'
-- own nested products jsonb, ~93k orders / ~223k service rows / ~446k
-- product-array elements for a typical recent month) genuinely costs
-- ~30-32s regardless of join strategy (tested both the planner's own hash
-- join and a forced nested-loop-via-index plan — both landed at ~30s,
-- confirming the cost is real data volume + this project's disk I/O, not a
-- fixable index gap). That's within reach of the 'authenticated' role's
-- default 30s statement_timeout on a bad day, which is exactly what
-- produced the reported "canceling statement due to statement timeout"
-- banner. This table is refreshed ONE MONTH AT A TIME (same reasoning as
-- droptop_order_month_rollup, migration 20260930c: a single-month scan
-- stays a bounded, roughly-constant cost regardless of how large the
-- underlying tables grow overall) and read from cheaply forever after.
CREATE TABLE IF NOT EXISTS inventory.product_sales_monthly (
  company_id         uuid        NOT NULL,
  location_id        uuid        NOT NULL,
  product_id         text        NOT NULL,
  sale_month         date        NOT NULL, -- always the 1st of the month
  category           text,
  simple_category    text,
  qty_usage_ledger   numeric     NOT NULL DEFAULT 0, -- inventory.daily_product_activity.sold_qty
  qty_order_services numeric     NOT NULL DEFAULT 0, -- inventory.droptop_order_services' nested products[]
  qty_sold           numeric GENERATED ALWAYS AS (qty_usage_ledger + qty_order_services) STORED,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, location_id, product_id, sale_month)
);
CREATE INDEX IF NOT EXISTS idx_product_sales_monthly_month ON inventory.product_sales_monthly (company_id, sale_month);
CREATE INDEX IF NOT EXISTS idx_product_sales_monthly_product ON inventory.product_sales_monthly (company_id, product_id);

ALTER TABLE inventory.product_sales_monthly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_sales_monthly_select" ON inventory.product_sales_monthly;
CREATE POLICY "product_sales_monthly_select" ON inventory.product_sales_monthly FOR SELECT
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));
-- Written by refresh_product_sales_monthly() below, itself SECURITY INVOKER
-- and called by a real logged-in user's session — same "any authenticated
-- company member who can see this page can also refresh it" reasoning
-- droptop_order_month_rollup's own manage policy already uses; this is a
-- read-model cache of already-visible sales data, not sensitive on its own.
DROP POLICY IF EXISTS "product_sales_monthly_manage" ON inventory.product_sales_monthly;
CREATE POLICY "product_sales_monthly_manage" ON inventory.product_sales_monthly FOR ALL
  USING (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()))
  WITH CHECK (company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid()));

-- Refreshes exactly one calendar month for the caller's own company:
-- deletes that company+month's existing rows and re-inserts fresh
-- (snapshot-replace, same convention as the RelaDyne Open Sales
-- Order/Invoice ledgers — simpler and safer than an upsert-with-
-- reconciliation-delete for a rebuildable rollup like this one).
--
-- Category resolution: inventory.daily_product_activity carries its own
-- per-row `category` (Droptop's own usage/inventory feed, reliably
-- populated — unlike droptop_order_services' nested product items, whose
-- product_type/financial_category_name are NOT reliably populated, see
-- DroptopOrdersPage.tsx/CustomerHeatmapPage.tsx's own header comments on
-- this). For a product/month with usage-ledger rows, its own mode()
-- (most-frequent) category wins; for an order-services-only product with
-- no usage-ledger row that month, falls back to that product_id's
-- all-time modal category from inventory.product_usage (99.99% populated,
-- confirmed 96% single-valued per product_id across shops company-wide).
-- simple_category is resolved via the existing category_simplification
-- lookup at refresh time (baked in, not joined live on every read) — a
-- later reclassification only reaches already-written months on their next
-- refresh, an accepted tradeoff for a historical-sales rollup.
--
-- statement_timeout is raised well above the ~30-32s observed cost for one
-- month at current volume (same "give real headroom, not a bare minimum"
-- precedent as the Droptop Summary/Price Audit timeout fix, 90s->180s).
CREATE OR REPLACE FUNCTION public.refresh_product_sales_monthly(p_month date)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
SET statement_timeout = '150s'
AS $$
DECLARE
  v_company_id uuid := (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid());
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_count integer;
BEGIN
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'no company for current user';
  END IF;

  DELETE FROM inventory.product_sales_monthly
  WHERE company_id = v_company_id AND sale_month = v_start;

  WITH usage_agg AS (
    SELECT location_id, product_id,
           sum(sold_qty) AS qty,
           mode() WITHIN GROUP (ORDER BY category) AS category
    FROM inventory.daily_product_activity
    WHERE company_id = v_company_id
      AND activity_date >= v_start AND activity_date < v_end
      AND product_id IS NOT NULL AND location_id IS NOT NULL
    GROUP BY location_id, product_id
  ),
  order_agg AS (
    SELECT o.location_id,
           (p->>'product_id') AS product_id,
           sum(coalesce((p->>'quantity_total')::numeric, 0)) AS qty
    FROM inventory.droptop_orders o
    JOIN inventory.droptop_order_services s ON s.order_id = o.id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.products, '[]'::jsonb)) AS p
    WHERE o.company_id = v_company_id
      AND o.location_id IS NOT NULL
      AND o.order_finalized_at >= v_start::timestamptz
      AND o.order_finalized_at < v_end::timestamptz
      AND (p->>'product_id') IS NOT NULL
    GROUP BY 1, 2
  ),
  product_category AS (
    SELECT product_id, mode() WITHIN GROUP (ORDER BY category) AS category
    FROM inventory.product_usage
    WHERE company_id = v_company_id AND category IS NOT NULL
    GROUP BY product_id
  ),
  combined AS (
    SELECT coalesce(u.location_id, o.location_id) AS location_id,
           coalesce(u.product_id, o.product_id) AS product_id,
           coalesce(u.qty, 0) AS qty_usage_ledger,
           coalesce(o.qty, 0) AS qty_order_services,
           u.category AS activity_category
    FROM usage_agg u
    FULL OUTER JOIN order_agg o
      ON o.location_id = u.location_id AND o.product_id = u.product_id
  )
  INSERT INTO inventory.product_sales_monthly
    (company_id, location_id, product_id, sale_month, category, simple_category, qty_usage_ledger, qty_order_services)
  SELECT v_company_id, c.location_id, c.product_id, v_start,
         coalesce(c.activity_category, pc.category) AS category,
         cs.simple_category,
         c.qty_usage_ledger, c.qty_order_services
  FROM combined c
  LEFT JOIN product_category pc ON pc.product_id = c.product_id
  LEFT JOIN inventory.category_simplification cs
    ON cs.company_id = v_company_id AND cs.category = coalesce(c.activity_category, pc.category)
  -- Two overlapping refreshes of the SAME month (e.g. a double-click, or
  -- "Refresh Recent" firing while a full backfill is still mid-flight) can
  -- otherwise race: both see the same pre-delete state, both compute the
  -- same rows, and whichever commits second hits this table's own primary
  -- key on the first one's just-inserted rows (hit live seeding this
  -- table's initial history, 2026-09-29). ON CONFLICT makes a race a
  -- harmless last-write-wins upsert instead of an error.
  ON CONFLICT (company_id, location_id, product_id, sale_month) DO UPDATE SET
    category = EXCLUDED.category,
    simple_category = EXCLUDED.simple_category,
    qty_usage_ledger = EXCLUDED.qty_usage_ledger,
    qty_order_services = EXCLUDED.qty_order_services,
    updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.refresh_product_sales_monthly(date) TO authenticated;

-- The Product Sales History page's Monthly Summary landing view (by
-- simple_category, then drilled into by shop) needs to support an
-- arbitrary Region/Market/AM/Shop filter applied client-side, so it can't
-- pre-aggregate away location_id server-side — but returning full
-- per-PRODUCT detail for every shop over a multi-month range would still be
-- a large payload (one recent month alone has ~65k distinct shop/product
-- combinations company-wide). Collapsing to (location_id, simple_category,
-- sale_month) instead keeps the row count tiny regardless of range (at
-- most shops × 4 categories × months) while still letting the client filter
-- by shop and drill from company-wide -> category -> shop. Product-level
-- detail for one specific (already-picked) shop is fetched directly from
-- the small per-shop slice of product_sales_monthly itself, never through
-- this RPC.
CREATE OR REPLACE FUNCTION public.get_product_sales_monthly_by_shop_category(
  p_start date,
  p_end date
)
RETURNS TABLE (location_id uuid, simple_category text, sale_month date, qty numeric)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT location_id, simple_category, sale_month, sum(qty_sold) AS qty
  FROM inventory.product_sales_monthly
  WHERE company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
    AND sale_month >= p_start AND sale_month <= p_end
  GROUP BY location_id, simple_category, sale_month
$$;
GRANT EXECUTE ON FUNCTION public.get_product_sales_monthly_by_shop_category(date, date) TO authenticated;

-- Cheap coverage check for the backfill UI — a GROUP BY over this rollup
-- table itself (never the source tables), so it stays fast no matter how
-- far back the backfill has been run.
CREATE OR REPLACE FUNCTION public.get_product_sales_monthly_coverage()
RETURNS TABLE (sale_month date, row_count bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = ''
STABLE
AS $$
  SELECT sale_month, count(*) AS row_count
  FROM inventory.product_sales_monthly
  WHERE company_id = (SELECT company_id FROM platform.user_profiles WHERE id = auth.uid())
  GROUP BY sale_month
  ORDER BY sale_month
$$;
GRANT EXECUTE ON FUNCTION public.get_product_sales_monthly_coverage() TO authenticated;
