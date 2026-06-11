-- =====================================================================
-- PHASE 3 — ORDER MODULE (port of order-generator)
-- Extends Phase 1 order tables; adds profiles, MOQ rules, documents.
-- Idempotent: safe to run multiple times.
-- =====================================================================

-- ---------------------------------------------------------------------
-- order_sessions — extend Phase 1 table
-- ---------------------------------------------------------------------
alter table order_sessions add column if not exists name text;
alter table order_sessions add column if not exists source_mode text;
alter table order_sessions add column if not exists input_snapshot jsonb;
alter table order_sessions add column if not exists generation_params jsonb;
alter table order_sessions add column if not exists exported_at timestamptz;

-- Widen status to include 'generated'
alter table order_sessions drop constraint if exists order_sessions_status_check;
alter table order_sessions add constraint order_sessions_status_check
  check (status in ('draft', 'generated', 'exported', 'pending', 'fulfilled'));

alter table order_sessions drop constraint if exists order_sessions_source_mode_check;
alter table order_sessions add constraint order_sessions_source_mode_check
  check (source_mode is null or source_mode in ('manual', 'file', 'live'));

-- ---------------------------------------------------------------------
-- order_line_items — extend Phase 1 table
-- ---------------------------------------------------------------------
alter table order_line_items add column if not exists company_id uuid references companies(id) on delete cascade;
alter table order_line_items add column if not exists vendor_part_number text;
alter table order_line_items add column if not exists suggested_qty numeric;
alter table order_line_items add column if not exists final_qty numeric;
alter table order_line_items add column if not exists package_type text;
alter table order_line_items add column if not exists applied_min_rule text;
alter table order_line_items add column if not exists trigger_reason text;
alter table order_line_items add column if not exists manual_override boolean not null default false;

-- ---------------------------------------------------------------------
-- order_profiles — Supabase replacement for localStorage profiles
-- ---------------------------------------------------------------------
create table if not exists order_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  scope text,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- ---------------------------------------------------------------------
-- order_min_rules — persisted flexible MOQ engine
-- ---------------------------------------------------------------------
create table if not exists order_min_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text,
  applies_to jsonb not null default '{}'::jsonb, -- { scope, location, field, value }
  bulk_minimum numeric,
  individual_minimum numeric,
  uom text,
  package_type text,
  rule_logic jsonb, -- { caseSize, maxQty, maxOnHandAfter }
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- order_documents — start/export stage uploads (Supabase storage)
-- ---------------------------------------------------------------------
create table if not exists order_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  order_session_id uuid references order_sessions(id) on delete cascade,
  stage text not null check (stage in ('start', 'export')),
  file_name text not null,
  storage_path text not null,
  uploaded_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- RLS — company-scoped access
-- ---------------------------------------------------------------------
alter table order_profiles   enable row level security;
alter table order_min_rules  enable row level security;
alter table order_documents  enable row level security;

drop policy if exists "Company members manage order_profiles" on order_profiles;
create policy "Company members manage order_profiles" on order_profiles
  for all using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

drop policy if exists "Company members manage order_min_rules" on order_min_rules;
create policy "Company members manage order_min_rules" on order_min_rules
  for all using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

drop policy if exists "Company members manage order_documents" on order_documents;
create policy "Company members manage order_documents" on order_documents
  for all using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

-- order_line_items now has company_id — add a direct company policy alongside the
-- Phase 1 join-based policies (either grants access).
drop policy if exists "Company members manage order_line_items direct" on order_line_items;
create policy "Company members manage order_line_items direct" on order_line_items
  for all using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

-- ---------------------------------------------------------------------
-- REALTIME
-- ---------------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table order_line_items; exception when duplicate_object then null; end $$;
-- order_sessions already added to realtime in Phase 1; guard in case it wasn't
do $$ begin alter publication supabase_realtime add table order_sessions; exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- STORAGE — order-documents bucket (private) + company-scoped policies
-- Objects are stored under path: <company_id>/<session_id>/<filename>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
  values ('order-documents', 'order-documents', false)
  on conflict (id) do nothing;

drop policy if exists "Company members read order docs" on storage.objects;
create policy "Company members read order docs" on storage.objects
  for select using (
    bucket_id = 'order-documents'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );

drop policy if exists "Company members upload order docs" on storage.objects;
create policy "Company members upload order docs" on storage.objects
  for insert with check (
    bucket_id = 'order-documents'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );

drop policy if exists "Company members delete order docs" on storage.objects;
create policy "Company members delete order docs" on storage.objects
  for delete using (
    bucket_id = 'order-documents'
    and (storage.foldername(name))[1] = get_my_company_id()::text
  );
