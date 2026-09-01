-- Both Customer Heatmap and Droptop Orders keyset-paginate
-- inventory.droptop_orders by ORDER BY id (not order_finalized_at), while
-- filtering WHERE order_finalized_at BETWEEN ... — with no index covering
-- that filter column, Postgres has no way to seek directly to the matching
-- date range and instead has to walk the id-ordered keyspace applying the
-- date filter as a residual check row by row. A WIDE range (e.g. week to
-- date) matches a large enough fraction of the table that a plain
-- sequential scan is still cheap; a NARROW custom range (e.g. one day) can
-- require scanning nearly the whole table just to find or rule out a
-- handful of matches, which is what was hitting the statement timeout.
--
-- This index lets a (company_id, date range) filter resolve via a direct
-- index range scan regardless of how narrow the range is. Paired with the
-- app-side fix (ordering by order_finalized_at, id instead of just id, so
-- the keyset cursor can actually walk this index).
CREATE INDEX IF NOT EXISTS idx_droptop_orders_company_finalized
  ON inventory.droptop_orders (company_id, order_finalized_at, id);
