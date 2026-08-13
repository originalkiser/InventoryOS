-- Tank monitor extended fields for the Tank Monitors page.
-- source_location keeps the raw shop string from uploads so unmatched monitors
-- can be mapped to a location later. total_capacity is derived from gross
-- inventory (on_hand) + available capacity.
-- Safe to re-run.
alter table inventory.tank_monitors
  add column if not exists volume_alarm_status text,
  add column if not exists key_note           text,
  add column if not exists battery_pct         numeric,
  add column if not exists serial_rtu_id       text,
  add column if not exists system_tank_id      text,
  add column if not exists level_inches        numeric,
  add column if not exists low_set_point_pct   numeric,
  add column if not exists height              numeric,
  add column if not exists source_location     text;

-- Total tank capacity = gross inventory (on_hand) + available (empty) capacity.
alter table inventory.tank_monitors
  add column if not exists total_capacity numeric
  generated always as (coalesce(on_hand, 0) + coalesce(available_capacity, 0)) stored;
