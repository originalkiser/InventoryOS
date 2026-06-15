-- Tank Monitor: per the spec the default columns are Location, Product,
-- Keep-fill enabled?, Inventory Date (reading_date), On hand.
alter table tank_monitors add column if not exists product_id text;
alter table tank_monitors add column if not exists keep_fill boolean not null default false;
alter table tank_monitors add column if not exists on_hand numeric;
