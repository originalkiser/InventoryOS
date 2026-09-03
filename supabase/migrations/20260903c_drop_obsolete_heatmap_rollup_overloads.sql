-- Cleanup: CREATE OR REPLACE FUNCTION with a different parameter list
-- creates a new overload rather than replacing the old one (Postgres
-- identifies a function by name+signature). Two intermediate iterations
-- of refresh_heatmap_zip_rollups from earlier today (a p_since/p_until
-- wall-clock-window version, and a p_since/p_max_groups group-count-only
-- version — see 20260903b_heatmap_rollup_refresh_row_bounded.sql for why
-- neither actually worked) plus the original single-argument version
-- were all left behind as dead code, still exposed as callable RPC
-- endpoints (flagged by the security advisor as anon/authenticated-
-- executable SECURITY DEFINER functions). Only heatmap-rollup-refresh
-- calls this RPC, already on the 3-parameter signature — safe to drop
-- the rest.
DROP FUNCTION IF EXISTS public.refresh_heatmap_zip_rollups(timestamp with time zone);
DROP FUNCTION IF EXISTS public.refresh_heatmap_zip_rollups(timestamp with time zone, timestamp with time zone);
DROP FUNCTION IF EXISTS public.refresh_heatmap_zip_rollups(timestamp with time zone, integer);
