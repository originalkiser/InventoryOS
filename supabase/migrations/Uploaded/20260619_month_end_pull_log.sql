-- Integration 3: Audit log for each Droptop API pull attempt

create table if not exists month_end_pull_log (
  id uuid primary key default gen_random_uuid(),
  pull_date date not null,
  pulled_at timestamptz not null default now(),
  locations_pulled int not null default 0,
  records_written int not null default 0,
  status text not null check (status in ('success', 'error')),
  error_message text
);

create index if not exists month_end_pull_log_pulled_at_idx on month_end_pull_log(pulled_at desc);
create index if not exists month_end_pull_log_date_idx on month_end_pull_log(pull_date desc);

alter table month_end_pull_log enable row level security;

create policy "Authenticated users can read month_end_pull_log"
  on month_end_pull_log for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert month_end_pull_log"
  on month_end_pull_log for insert with check (auth.role() = 'authenticated');
