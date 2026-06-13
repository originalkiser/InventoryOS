-- =====================================================================
-- Issue Tracker — vendor column + user-defined custom columns.
-- Multi-tenant (company_id) + RLS consistent with the app. Idempotent.
-- =====================================================================

alter table issues add column if not exists vendor text;

-- Definitions for company-wide custom columns on the issues grid.
create table if not exists issue_tracker_columns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  label text not null,
  type text not null default 'text' check (type in ('text','number','date','status','checkbox')),
  sort_order int default 0,
  width int default 160,
  pinned boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_issue_columns_company on issue_tracker_columns (company_id, sort_order);

-- Cell values for custom columns, one row per (issue, column).
create table if not exists issue_custom_values (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  issue_id uuid not null references issues(id) on delete cascade,
  column_id uuid not null references issue_tracker_columns(id) on delete cascade,
  value text,
  unique (issue_id, column_id)
);
create index if not exists idx_issue_custom_values_issue on issue_custom_values (issue_id);

alter table issue_tracker_columns enable row level security;
alter table issue_custom_values enable row level security;

drop policy if exists "Company members read issue_tracker_columns" on issue_tracker_columns;
create policy "Company members read issue_tracker_columns" on issue_tracker_columns for select using (company_id = get_my_company_id());
drop policy if exists "Company members manage issue_tracker_columns" on issue_tracker_columns;
create policy "Company members manage issue_tracker_columns" on issue_tracker_columns for all
  using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

drop policy if exists "Company members read issue_custom_values" on issue_custom_values;
create policy "Company members read issue_custom_values" on issue_custom_values for select using (company_id = get_my_company_id());
drop policy if exists "Company members manage issue_custom_values" on issue_custom_values;
create policy "Company members manage issue_custom_values" on issue_custom_values for all
  using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='issue_custom_values') then
    alter publication supabase_realtime add table issue_custom_values;
  end if;
end $$;
