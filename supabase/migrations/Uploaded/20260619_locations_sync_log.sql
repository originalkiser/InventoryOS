-- Integration 2: monday.com location sync audit log

create table if not exists locations_sync_log (
  id uuid primary key default gen_random_uuid(),
  synced_at timestamptz not null default now(),
  records_updated int not null default 0,
  records_added int not null default 0,
  records_deactivated int not null default 0,
  status text not null check (status in ('success', 'partial', 'error')),
  error_message text
);

create index if not exists locations_sync_log_synced_at_idx on locations_sync_log(synced_at desc);

alter table locations_sync_log enable row level security;

create policy "Authenticated users can read locations_sync_log"
  on locations_sync_log for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert locations_sync_log"
  on locations_sync_log for insert with check (auth.role() = 'authenticated');
