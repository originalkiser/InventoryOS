-- GIN index on droptop_order_services.products (the nested per-service product
-- array). Lets "which orders contain product X" use an index instead of
-- sequentially scanning the ~4 GB / 6M-row table (a month of GM/Dexos checking
-- took ~77s without it, 40s of that purely reading services). jsonb_path_ops is
-- the smaller, containment-only (@>) flavor - that is all the callers need,
-- e.g. products @> '[{"product_id":"DEXOS-SYN-5W30D"}]'.
-- Must run on its own (CREATE INDEX CONCURRENTLY cannot be inside a transaction
-- block), so it lives in a separate file from 20261010z_gm_dexos_check.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_droptop_order_services_products_gin
  ON inventory.droptop_order_services USING gin (products jsonb_path_ops);
