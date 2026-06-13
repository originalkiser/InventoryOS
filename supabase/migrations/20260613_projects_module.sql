-- =====================================================================
-- Projects module — project/task tracker with sub-tasks and per-user
-- column layout. Multi-tenant (company_id) + RLS consistent with the app.
-- Idempotent.
-- =====================================================================

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_name text not null,
  start_date date,
  target_end_date date,
  status text default 'Not Started',
  last_update timestamptz default now(),
  description text,
  vendor text,
  category text,
  sort_order int default 0,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_projects_company on projects (company_id, sort_order);

create table if not exists project_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  task_name text not null,
  status text default 'Not Started',
  assignee text,
  due_date date,
  notes text,
  done boolean not null default false,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_project_tasks_project on project_tasks (project_id, sort_order);

-- Per-user column layout (order/pin/width/visibility) for the projects grid.
create table if not exists projects_column_config (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  config jsonb not null default '[]'::jsonb,
  updated_at timestamptz default now(),
  unique (company_id, user_id)
);

alter table projects enable row level security;
alter table project_tasks enable row level security;
alter table projects_column_config enable row level security;

drop policy if exists "Company members read projects" on projects;
create policy "Company members read projects" on projects for select using (company_id = get_my_company_id());
drop policy if exists "Company members manage projects" on projects;
create policy "Company members manage projects" on projects for all
  using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

drop policy if exists "Company members read project_tasks" on project_tasks;
create policy "Company members read project_tasks" on project_tasks for select using (company_id = get_my_company_id());
drop policy if exists "Company members manage project_tasks" on project_tasks;
create policy "Company members manage project_tasks" on project_tasks for all
  using (company_id = get_my_company_id()) with check (company_id = get_my_company_id());

-- Column config is per-user.
drop policy if exists "Users read own projects_column_config" on projects_column_config;
create policy "Users read own projects_column_config" on projects_column_config for select
  using (company_id = get_my_company_id() and user_id = auth.uid());
drop policy if exists "Users manage own projects_column_config" on projects_column_config;
create policy "Users manage own projects_column_config" on projects_column_config for all
  using (company_id = get_my_company_id() and user_id = auth.uid())
  with check (company_id = get_my_company_id() and user_id = auth.uid());

-- Realtime (guarded — re-adding a table already in the publication errors).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='projects') then
    alter publication supabase_realtime add table projects;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='project_tasks') then
    alter publication supabase_realtime add table project_tasks;
  end if;
end $$;
