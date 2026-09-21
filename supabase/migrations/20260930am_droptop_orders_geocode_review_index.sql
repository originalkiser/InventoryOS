-- Found live 2026-09-20 via a pg_stat_statements review: the "Geocode
-- Orders" review queries (address IS NOT NULL, optionally filtered by
-- geocode_status) had no supporting index at all — the only existing
-- geocode index (idx_droptop_orders_geocode_pending) covers the opposite
-- case (geocode_status IS NULL, newly-arrived orders awaiting geocode).
-- Real production evidence: these 3 query shapes averaged 23-57% cache
-- hit rate (i.e. mostly real disk reads) and ~9s each for a paginated,
-- id-only SELECT. INCLUDE (id) makes this a covering index for the
-- id-only PostgREST pagination query these queries actually run, so it
-- can resolve as an index-only scan without touching the (wide, jsonb-
-- heavy) droptop_orders heap at all.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_droptop_orders_geocode_review
  ON inventory.droptop_orders (company_id, geocode_status)
  INCLUDE (id)
  WHERE address IS NOT NULL;
