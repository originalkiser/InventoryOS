-- Fixes a real bug found live 2026-09-08: the Customer Heatmap - Zip
-- Rollups scheduled refresh had been stuck reprocessing the exact same
-- watermark ('2026-09-03T11:57:22.186Z') on every dispatcher tick for 5
-- days straight, and periodically surfaced as "canceling statement due to
-- statement timeout" from redoing the same real work over and over.
--
-- Root cause: a large historical backfill stamped ~20,000 droptop_orders
-- rows with just 11 distinct updated_at timestamps (bulk per-batch
-- commits). 90 of the resulting (company, location, order_date) groups
-- tied on the SAME earliest timestamp -- more than p_max_groups (60).
-- `ORDER BY group_watermark ASC LIMIT 60` arbitrarily selected 60 of those
-- 90 tied groups, so the batch's own max processed watermark never
-- actually exceeded p_since (GREATEST(p_since, tied_ts - 1s) = p_since) --
-- the watermark could not move forward at all, and the calling edge
-- function (heatmap-rollup-refresh) treats "didn't advance" as "caught
-- up" and stops, so the identical window gets refetched and reprocessed
-- every single tick forever.
--
-- Two-part fix, both required (confirmed live -- the first alone still
-- stalled on this exact watermark):
-- 1. Widen the batch to include every group tied on the p_max_groups-th
--    group's watermark, instead of an arbitrary LIMIT cut mid-tie.
-- 2. Only apply the original "- 1 second" defensive buffer when the
--    touched boundary sits at the very edge of the whole candidate_rows
--    fetch (genuine row-level truncation risk, i.e. p_max_rows might have
--    cut off more same-instant siblings we never saw) -- when it's
--    comfortably earlier than that, the full tie was already captured
--    entirely by (1), so advance straight to it.
--
-- Manually drained the resulting 5-day backlog live via this fixed
-- function (watermark 2026-09-03T11:57:22Z -> caught up to ~now) before
-- committing this migration -- no data changes needed here, that drain
-- was done with the same public API this file defines.
create or replace function public.refresh_heatmap_zip_rollups(
  p_since timestamp with time zone,
  p_max_groups integer default null::integer,
  p_max_rows integer default 20000
)
returns table(dates_recomputed integer, rows_upserted integer, new_watermark timestamp with time zone)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_dates_recomputed integer := 0;
  v_rows_upserted    integer := 0;
  v_new_watermark    timestamptz;
  v_max_touched      timestamptz;
  v_full_max         timestamptz;
  v_boundary_watermark timestamptz;
begin
  create temp table candidate_rows on commit drop as
  select o.company_id, o.location_id,
         (o.order_finalized_at at time zone 'UTC')::date as order_date,
         o.updated_at
  from inventory.droptop_orders o
  where o.updated_at > p_since
    and o.order_finalized_at is not null
  order by o.updated_at asc
  limit p_max_rows;

  select max(updated_at) into v_full_max from candidate_rows;

  create temp table groups_all on commit drop as
  select company_id, location_id, order_date, max(updated_at) as group_watermark
  from candidate_rows
  group by 1, 2, 3;

  -- Find the watermark of the p_max_groups-th group (deterministic
  -- tiebreak), then widen to include every group tied on that exact
  -- timestamp -- see header comment for why a plain LIMIT cut mid-tie
  -- stalls the watermark permanently.
  if p_max_groups is not null then
    select group_watermark into v_boundary_watermark
    from groups_all
    order by group_watermark asc, company_id, location_id, order_date
    limit 1 offset greatest(p_max_groups - 1, 0);
  end if;

  create temp table touched_dates on commit drop as
  select company_id, location_id, order_date
  from groups_all
  where v_boundary_watermark is null or group_watermark <= v_boundary_watermark;

  select count(*) into v_dates_recomputed from touched_dates;

  if v_dates_recomputed = 0 then
    return query select 0, 0, p_since;
    return;
  end if;

  select max(c.updated_at) into v_max_touched
  from candidate_rows c
  join touched_dates t
    on t.company_id = c.company_id and t.location_id = c.location_id and t.order_date = c.order_date;

  -- Only pull back by 1 second when the touched boundary sits at the very
  -- edge of the whole candidate_rows fetch (genuine row-level truncation
  -- risk) -- otherwise the full tie was already captured above, so
  -- advance straight to it.
  if v_max_touched < v_full_max then
    v_new_watermark := greatest(p_since, v_max_touched);
  else
    v_new_watermark := greatest(p_since, v_max_touched - interval '1 second');
  end if;

  delete from inventory.heatmap_zip_rollups r
  using touched_dates t
  where r.company_id = t.company_id
    and r.location_id = t.location_id
    and r.order_date = t.order_date;

  insert into inventory.heatmap_zip_rollups
    (company_id, location_id, zip, order_date, city, region, lat, lng, order_count, ticket_total, updated_at)
  select
    o.company_id, o.location_id, o.zip,
    (o.order_finalized_at at time zone 'UTC')::date,
    max(o.city), max(o.region), max(o.lat), max(o.lng),
    count(*), sum(coalesce(o.final_price, 0)), now()
  from inventory.droptop_orders o
  join touched_dates t
    on t.company_id = o.company_id
   and t.location_id = o.location_id
   and t.order_date = (o.order_finalized_at at time zone 'UTC')::date
  where o.zip is not null and o.zip <> ''
  group by o.company_id, o.location_id, o.zip, (o.order_finalized_at at time zone 'UTC')::date;

  get diagnostics v_rows_upserted = row_count;

  return query select v_dates_recomputed, v_rows_upserted, v_new_watermark;
end;
$function$;
