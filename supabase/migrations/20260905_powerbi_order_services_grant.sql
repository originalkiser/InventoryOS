-- Missed in 20260904_orders_services_and_powerbi_grants.sql: that
-- migration added inventory.droptop_order_services' RLS policy for
-- powerbi_reader but never granted the role table-level SELECT on it in
-- the first place (unlike droptop_orders/_packages/_products, which all
-- got an explicit GRANT there). The RLS policy alone does nothing without
-- the underlying table grant. Idempotent — safe to run whether or not
-- ALTER DEFAULT PRIVILEGES from 20260901c already covered this table via
-- the role that created it.
GRANT SELECT ON inventory.droptop_order_services TO powerbi_reader;
