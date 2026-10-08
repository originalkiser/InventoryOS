-- Droptop Orders summary: the once-a-day cache (20260930bm) was filled lazily by whoever opened a preset period first each day, and that
-- first call computes live (company-wide, now ~minutes of cold I/O at current table size) and can time out - so the cache never fills and
-- the next person hits the same wall. Fix: fill it ahead of time from a scheduled job, and give the wrapper its own timeout headroom.
ALTER FUNCTION public.get_droptop_orders_summary_stats_cached(uuid, text, timestamptz, timestamptz) SET statement_timeout = '200s';

CREATE OR REPLACE FUNCTION inventory.refresh_droptop_orders_summary_cache(p_only text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = inventory, public, pg_temp SET statement_timeout = '900s' AS $$
DECLARE
  tz text := coalesce((SELECT value #>> '{}' FROM platform.app_settings WHERE key = 'data_connection_timezone' LIMIT 1), 'America/Chicago');
  today date := (now() AT TIME ZONE tz)::date;
  wk date := today - extract(dow FROM today)::int;     -- Sunday-start week, same as the app
  co uuid;
  p record;
  n integer := 0;
  v jsonb;
BEGIN
  FOR co IN SELECT DISTINCT company_id FROM core.locations WHERE company_id IS NOT NULL LOOP
    FOR p IN
      SELECT * FROM (VALUES
        ('wtd',           wk,                                              today),
        ('last_week',     wk - 7,                                          wk - 1),
        ('last_7_days',   today - 7,                                       today - 1),
        ('mtd',           date_trunc('month', today)::date,                today),
        ('last_month',    (date_trunc('month', today) - interval '1 month')::date, (date_trunc('month', today) - interval '1 day')::date),
        ('last_30_days',  today - 30,                                      today - 1),
        ('last_3_months', today - 90,                                      today)
      ) AS t(period_key, s, e)
      WHERE p_only IS NULL OR t.period_key = p_only
    LOOP
      BEGIN
        -- Compute first, then replace today's entry, so a failed recompute never throws away a good cached result.
        v := public.get_droptop_orders_summary_stats(co, (p.s::text || 'T00:00:00.000Z')::timestamptz, (p.e::text || 'T23:59:59.999Z')::timestamptz, NULL);
        INSERT INTO inventory.droptop_orders_summary_cache (company_id, period_key, computed_date, payload) VALUES (co, p.period_key, current_date, v)
        ON CONFLICT (company_id, period_key, computed_date) DO UPDATE SET payload = excluded.payload, computed_at = now();
        n := n + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'summary cache % failed: %', p.period_key, SQLERRM;
      END;
    END LOOP;
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION inventory.refresh_droptop_orders_summary_cache(text) FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS inventory.refresh_droptop_orders_summary_cache();
-- 10:00 UTC = 5am Central, after the overnight order sync; the cache day flips at UTC midnight so this fills the whole business day.
SELECT cron.schedule('droptop-orders-summary-prewarm', '0 10 * * *', $$SELECT inventory.refresh_droptop_orders_summary_cache()$$);
