-- Orders v2 — per-vendor visibility on the "Start New Order" picker
-- (direct ask 2026-09-30: "add settings for vendors to show on order
-- selection, so we can add vendors and hide vendors later"). Defaults to
-- true so every existing vendor keeps showing up with no data migration
-- needed — hiding one is an explicit, later action from Order Settings.

alter table inventory.vendors
  add column if not exists show_in_order_selection boolean not null default true;
