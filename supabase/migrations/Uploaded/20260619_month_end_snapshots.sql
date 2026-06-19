-- Integration 3: Droptop daily on-hand snapshots during month-end period

create table if not exists month_end_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  location_id text not null,
  product_name text not null,
  sku text,
  on_hand_qty numeric not null default 0,
  ending_balance numeric,
  uom text,
  pulled_at timestamptz not null default now(),
  source text not null default 'droptop',
  unique (snapshot_date, location_id, product_name)
);

create index if not exists month_end_snapshots_date_idx on month_end_snapshots(snapshot_date desc);
create index if not exists month_end_snapshots_location_idx on month_end_snapshots(location_id);

alter table month_end_snapshots enable row level security;

create policy "Authenticated users can read month_end_snapshots"
  on month_end_snapshots for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert month_end_snapshots"
  on month_end_snapshots for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can update month_end_snapshots"
  on month_end_snapshots for update using (auth.role() = 'authenticated');
