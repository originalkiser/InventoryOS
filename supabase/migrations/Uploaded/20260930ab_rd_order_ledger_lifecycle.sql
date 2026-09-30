-- RD Reports — order lifecycle tracking on the existing accumulating
-- rd_order_ledger (direct ask 2026-09-30: "each upload replaces its own
-- table, not a history... only adding new lines or updated lines when we
-- upload... check to see if it is now on the open invoice report and add
-- what the quantity delivered was"). rd_order_ledger already accumulates
-- across uploads (see 20260930au_rd_order_delivery_ledgers.sql) — this adds
-- the missing OPEN/CLOSED status so a line that drops off a fresh Open
-- Sales Order upload is explicitly resolved against rd_delivery_ledger
-- (the matching accumulating invoice history) instead of just vanishing.
--
-- status:
--   open              - still on the vendor's own open sales order report
--   closed_delivered  - dropped off the report AND a matching invoice line
--                       was found (delivered_qty/delivered_at set from it)
--   closed_no_invoice - dropped off the report but no matching invoice line
--                       was ever found — needs following up with the vendor

alter table inventory.rd_order_ledger
  add column if not exists status text not null default 'open',
  add column if not exists delivered_qty numeric,
  add column if not exists delivered_at date,
  add column if not exists closed_at timestamptz;

alter table inventory.rd_order_ledger drop constraint if exists rd_order_ledger_status_check;
alter table inventory.rd_order_ledger add constraint rd_order_ledger_status_check
  check (status in ('open', 'closed_delivered', 'closed_no_invoice'));

-- The user's own ask uses the invoice's SHIP date as "the delivery date" —
-- rd_delivery_ledger only ever carried invoice_date, never ship_date, so
-- there was nothing to actually read that from.
alter table inventory.rd_delivery_ledger
  add column if not exists ship_date date;
