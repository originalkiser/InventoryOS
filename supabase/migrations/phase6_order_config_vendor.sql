-- =====================================================================
-- PHASE 6 — Order config per vendor.
-- Lets the same location+product carry a separate config per supplying vendor,
-- and supports a per-vendor order-config upload. Idempotent.
-- =====================================================================

alter table location_order_configs
  add column if not exists vendor_id uuid references vendors(id) on delete set null;

create index if not exists idx_location_order_configs_vendor
  on location_order_configs (company_id, vendor_id);
