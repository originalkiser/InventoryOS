-- get_droptop_order_location_ids_in_range never got the same
-- SET statement_timeout = '30s' guard the 4 daily-coverage RPCs already
-- have (migration 20260930q_data_health_coverage_rpcs_timeout.sql), despite
-- being the same class of query: CLAUDE.md's own notes already document
-- this one as genuinely expensive at current volume (real disk-spilling
-- sort for count(DISTINCT location_id)). Found 2026-09-20 via a
-- pg_stat_statements review showing 5 calls averaging 10.9s each. Scoped
-- to exactly this function, no role/project-wide setting touched.
ALTER FUNCTION public.get_droptop_order_location_ids_in_range(date, date)
  SET statement_timeout = '30s';
