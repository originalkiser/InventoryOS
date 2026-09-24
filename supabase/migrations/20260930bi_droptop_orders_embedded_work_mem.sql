-- Follow-up to 20260930bh — user asked whether raising the Droptop Orders
-- page's own page size (2,000 -> 8,000 rows/page) was blocked by
-- PostgREST's 10,000-row Max Rows setting. It isn't (this RPC returns
-- exactly one row per order, packages/products/etc. packed into json
-- columns on that row rather than separate rows, so Max Rows only ever
-- counts orders) — but testing the idea directly (EXPLAIN ANALYZE) surfaced
-- a real, separate issue worth fixing regardless of page size: work_mem on
-- this database is only 3.5MB, small enough that the per-child GROUP BY/
-- json_agg aggregation spills to an on-disk temp file even at the
-- function's default 2,000-row page — confirmed via EXPLAIN ANALYZE's own
-- "temp read/written" line, present on every run regardless of cache
-- warmth. A 32MB function-level override (trivial for a single call's own
-- memory footprint) removes the spill entirely — confirmed via a clean
-- before/after EXPLAIN ANALYZE comparison, both at the current 2,000-row
-- page and at a test 8,000-row page. Page size itself was left at 2,000 —
-- see this function's own 20260930bh header comment; raising it wasn't
-- shown to be a clear win once the wider-scan and cold-cache costs of a
-- bigger page were isolated from this work_mem effect.
ALTER FUNCTION public.get_droptop_orders_embedded(uuid, timestamptz, timestamptz, uuid[], timestamptz, uuid, int)
  SET work_mem = '32MB';
