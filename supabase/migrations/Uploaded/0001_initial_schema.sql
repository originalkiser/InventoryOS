-- Enable UUID extension
create extension if not exists "pgcrypto";

-- =====================
-- COMPANIES & PROFILES
-- =====================

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users on delete cascade,
  company_id uuid references companies(id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'user' check (role in ('admin', 'user')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- CONFIG TABLES
-- =====================

create table locations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_code text not null,
  name text not null,
  region text,
  active boolean not null default true,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, location_code)
);

create table vendors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vendor_code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, vendor_code)
);

create table vendor_parts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  vendor_id uuid references vendors(id) on delete set null,
  part_number text not null,
  description text,
  unit_of_measure text,
  package_type text,
  bulk_minimum numeric,
  individual_minimum numeric,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table product_id_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  old_product_id text not null,
  new_product_id text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table global_products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  product_id text not null,
  unit_of_measure text,
  package_type text,
  bulk_minimum numeric,
  individual_minimum numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, product_id)
);

create table location_order_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  product_id text not null,
  capacity numeric,
  order_trigger numeric,
  order_limit numeric,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table monthly_ending_balances (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  month date not null,
  ending_balance numeric not null,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table data_source_links (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  config_type text not null,
  source_type text not null check (source_type in ('api', 'google_sheets', 'onedrive', 'sharepoint')),
  url text not null,
  refresh_interval_minutes int,
  last_synced_at timestamptz,
  credentials_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- MONTH END
-- =====================

create table monthly_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  count_date timestamptz not null,
  count_type text,
  total_adjustments numeric,
  adjustment_value numeric,
  abs_adjustment_value numeric,
  ending_inventory_cost numeric,
  uploaded_at timestamptz not null default now(),
  upload_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table monthly_count_products (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  upload_batch_id uuid,
  location_id uuid references locations(id) on delete set null,
  product_id text not null,
  on_hand numeric,
  sold numeric,
  adjusted numeric,
  ending_value numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table recount_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  recount_type text,
  requested_products text[],
  request_date date,
  recount_fields jsonb,
  completed_flags boolean[],
  completed_dates date[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table recount_config (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  low_adj_threshold numeric,
  high_adj_threshold numeric,
  low_balance_threshold numeric,
  high_balance_threshold numeric,
  variance_to_median_pct numeric,
  variance_to_last_month_pct numeric,
  median_months_lookback int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- WEEKLY COUNTS
-- =====================

create table weekly_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  count_date timestamptz not null,
  count_type text,
  total_adjustments numeric,
  adjustment_value numeric,
  abs_adjustment_value numeric,
  ending_inventory_cost numeric,
  upload_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- ORDERS
-- =====================

create table order_sessions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  created_by uuid references auth.users on delete set null,
  status text not null default 'draft' check (status in ('draft', 'exported', 'pending', 'fulfilled')),
  export_data jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table order_line_items (
  id uuid primary key default gen_random_uuid(),
  order_session_id uuid not null references order_sessions(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  product_id text not null,
  quantity numeric not null,
  unit_of_measure text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- ISSUES
-- =====================

create table issue_categories (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table issue_statuses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  location_id uuid references locations(id) on delete set null,
  category_id uuid references issue_categories(id) on delete set null,
  status_id uuid references issue_statuses(id) on delete set null,
  start_date date,
  target_resolution_date date,
  resolved_date date,
  resolution_notes text,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- SCHEDULE
-- =====================

create table schedule_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  title text not null,
  event_type text not null default 'other',
  start_date date not null,
  end_date date,
  recurrence jsonb,
  is_checklist boolean not null default false,
  completed boolean not null default false,
  completed_at timestamptz,
  completed_by uuid references auth.users on delete set null,
  assigned_to uuid[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =====================
-- REALTIME
-- =====================

alter publication supabase_realtime add table monthly_counts;
alter publication supabase_realtime add table weekly_counts;
alter publication supabase_realtime add table order_sessions;
alter publication supabase_realtime add table issues;
alter publication supabase_realtime add table recount_requests;
alter publication supabase_realtime add table schedule_events;
alter publication supabase_realtime add table issue_categories;
alter publication supabase_realtime add table issue_statuses;
