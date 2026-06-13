-- =====================================================================
-- Batch #2 config: Tank Monitor, Product Usage, POS location mapping, and a
-- generic per-company app_settings store (flag scale, allowable types, toggles).
-- Multi-tenant (company_id) + RLS consistent with the app. Idempotent.
-- =====================================================================

-- Tank monitor daily readings by location.
create table if not exists tank_monitors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  reading_date date not null default current_date,
  value numeric,
  unit text default 'gal',
  updated_by uuid references auth.users on delete set null,
  last_change_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_tank_monitors_company on tank_monitors (company_id, reading_date);

-- Product usage / days-of-supply by location+product.
create table if not exists product_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  product_id text not null,
  daily_usage numeric,
  on_hands numeric,
  days_of_supply numeric,
  updated_by uuid references auth.users on delete set null,
  last_change_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_product_usage_company on product_usage (company_id, location_id);

-- POS location strings ("1 - Thomasville") mapped to internal locations.
create table if not exists pos_location_map (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  pos_string text not null,
  location_id uuid references locations(id) on delete set null,
  updated_by uuid references auth.users on delete set null,
  last_change_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, pos_string)
);

-- Generic per-company settings (flag scale, allowable types, toggles).
create table if not exists app_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (company_id, key)
);

alter table tank_monitors enable row level security;
alter table product_usage enable row level security;
alter table pos_location_map enable row level security;
alter table app_settings enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tank_monitors','product_usage','pos_location_map','app_settings'] loop
    execute format('drop policy if exists "Company members read %1$s" on %1$s', t);
    execute format('create policy "Company members read %1$s" on %1$s for select using (company_id = get_my_company_id())', t);
    execute format('drop policy if exists "Company members manage %1$s" on %1$s', t);
    execute format('create policy "Company members manage %1$s" on %1$s for all using (company_id = get_my_company_id()) with check (company_id = get_my_company_id())', t);
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='tank_monitors') then
    alter publication supabase_realtime add table tank_monitors;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='product_usage') then
    alter publication supabase_realtime add table product_usage;
  end if;
end $$;
