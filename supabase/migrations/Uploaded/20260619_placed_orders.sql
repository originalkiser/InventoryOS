-- Integration 4: Placed Orders — 60-day retention with auto-archive

create table if not exists placed_orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  location_id text,
  location_name text,
  placed_at timestamptz not null default now(),
  placed_by uuid references auth.users(id),
  order_data jsonb not null default '{}',
  status text not null default 'placed'
    check (status in ('placed', 'received', 'cancelled', 'archived')),
  notes text,
  expires_at timestamptz not null generated always as (placed_at + interval '60 days') stored,
  is_archived boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists placed_orders_placed_at_idx on placed_orders(placed_at desc);
create index if not exists placed_orders_location_idx on placed_orders(location_id) where location_id is not null;
create index if not exists placed_orders_status_idx on placed_orders(status);
create index if not exists placed_orders_expires_at_idx on placed_orders(expires_at) where is_archived = false;

alter table placed_orders enable row level security;

create policy "Authenticated users can read placed_orders"
  on placed_orders for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert placed_orders"
  on placed_orders for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can update placed_orders"
  on placed_orders for update using (auth.role() = 'authenticated');
