-- Integration 2: Add monday.com sync columns to existing locations table
-- TODO: [SCHEMA] Verify existing column names against current locations table before applying

alter table locations
  add column if not exists order_date date,
  add column if not exists region text,
  add column if not exists district text,
  add column if not exists monday_item_id text unique,
  add column if not exists raw_monday_data jsonb,
  add column if not exists last_synced_at timestamptz;

create index if not exists locations_monday_item_id_idx on locations(monday_item_id) where monday_item_id is not null;
create index if not exists locations_region_idx on locations(region) where region is not null;
create index if not exists locations_district_idx on locations(district) where district is not null;
