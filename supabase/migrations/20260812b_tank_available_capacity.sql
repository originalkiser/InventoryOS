-- Available capacity entered directly on a tank monitor reading (no computation).
alter table inventory.tank_monitors
  add column if not exists available_capacity numeric;
