-- Integration 1: Daily Order Config — product-level ordering parameters
-- TODO: [SCHEMA] Add shop_ids foreign key constraint once locations table is stable

create table if not exists order_config (
  id uuid primary key default gen_random_uuid(),
  product_name text not null unique,
  sku text,
  uom text not null,
  trigger_qty numeric not null default 0,
  min_order_qty numeric not null default 0,
  shop_ids text[] not null default '{}',
  is_active boolean not null default true,
  last_updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists order_config_uom_idx on order_config(uom);
create index if not exists order_config_active_idx on order_config(is_active);

alter table order_config enable row level security;

create policy "Authenticated users can read order_config"
  on order_config for select using (auth.role() = 'authenticated');

create policy "Authenticated users can insert order_config"
  on order_config for insert with check (auth.role() = 'authenticated');

create policy "Authenticated users can update order_config"
  on order_config for update using (auth.role() = 'authenticated');
