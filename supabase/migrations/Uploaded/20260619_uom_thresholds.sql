-- Integration 1: UOM-level trigger/min-order quantity defaults

create table if not exists uom_thresholds (
  uom text primary key,
  trigger_qty numeric not null default 0,
  min_order_qty numeric not null default 0,
  display_label text,
  updated_at timestamptz not null default now()
);

alter table uom_thresholds enable row level security;

create policy "Authenticated users can read uom_thresholds"
  on uom_thresholds for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert uom_thresholds"
  on uom_thresholds for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can update uom_thresholds"
  on uom_thresholds for update using (auth.role() = 'authenticated');

create policy "Authenticated users can delete uom_thresholds"
  on uom_thresholds for delete using (auth.role() = 'authenticated');
