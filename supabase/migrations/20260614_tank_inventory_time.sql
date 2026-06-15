-- Tank Monitor: store the full inventory date+time (EST) from the export, not
-- just a date. reading_date stays (date) for stacking/uniqueness.
alter table tank_monitors add column if not exists inventory_time timestamptz;
