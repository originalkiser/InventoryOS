-- =====================================================================
-- PHASE 2 — MONTH END / WEEKLY: upload batches, mapping templates,
-- additive product batching, recount status.
-- Safe to run multiple times (idempotent via IF NOT EXISTS / drop policy).
-- =====================================================================

-- ---------------------------------------------------------------------
-- NEW TABLE: count_upload_batches
-- One row per file/source import. Batches stay separate (non-destructive);
-- product totals are computed by aggregation across batches for a period.
-- ---------------------------------------------------------------------
create table if not exists count_upload_batches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  module text not null check (module in ('monthly', 'weekly')),
  count_month date,
  file_name text,
  source_type text not null default 'file'
    check (source_type in ('file', 'api', 'google_sheets', 'onedrive', 'sharepoint')),
  uploaded_by uuid references auth.users on delete set null,
  row_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_count_upload_batches_period
  on count_upload_batches (company_id, module, count_month);

-- ---------------------------------------------------------------------
-- NEW TABLE: count_mapping_templates
-- Saved column-mapping presets per module, reusable across imports.
-- mappings jsonb: [{ fieldName, sourceColumn, invert }]
-- ---------------------------------------------------------------------
create table if not exists count_mapping_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  module text not null check (module in ('monthly_summary', 'monthly_product', 'weekly')),
  name text not null,
  mappings jsonb not null default '[]'::jsonb,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  unique (company_id, module, name)
);

-- ---------------------------------------------------------------------
-- ALTER existing tables (add columns only if missing)
-- ---------------------------------------------------------------------
alter table monthly_counts          add column if not exists count_month date;
alter table monthly_counts          add column if not exists upload_batch_id uuid;
alter table monthly_count_products  add column if not exists upload_batch_id uuid;
alter table monthly_count_products  add column if not exists count_month date;
alter table recount_requests        add column if not exists recount_status text not null default 'open'
  check (recount_status in ('open', 'in_progress', 'complete'));

-- ---------------------------------------------------------------------
-- RLS — standard company-scoped access for the two new tables
-- ---------------------------------------------------------------------
alter table count_upload_batches   enable row level security;
alter table count_mapping_templates enable row level security;

drop policy if exists "Company members can read count_upload_batches" on count_upload_batches;
create policy "Company members can read count_upload_batches"
  on count_upload_batches for select using (company_id = get_my_company_id());

drop policy if exists "Company members can manage count_upload_batches" on count_upload_batches;
create policy "Company members can manage count_upload_batches"
  on count_upload_batches for all using (company_id = get_my_company_id())
  with check (company_id = get_my_company_id());

drop policy if exists "Company members can read count_mapping_templates" on count_mapping_templates;
create policy "Company members can read count_mapping_templates"
  on count_mapping_templates for select using (company_id = get_my_company_id());

drop policy if exists "Company members can manage count_mapping_templates" on count_mapping_templates;
create policy "Company members can manage count_mapping_templates"
  on count_mapping_templates for all using (company_id = get_my_company_id())
  with check (company_id = get_my_company_id());

-- ---------------------------------------------------------------------
-- REALTIME — live batch list updates
-- (guard against duplicate-add errors if the migration is re-run)
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table count_upload_batches;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table monthly_count_products;
exception when duplicate_object then null;
end $$;
