-- Re-apply the forms visibility/category migration.
--
-- Production was erroring "Could not find the 'category'/'visibility' column of
-- 'forms' in the schema cache". The base forms.forms table (20260623140000_
-- form_builder.sql) is live and has every column the app writes EXCEPT the two
-- added by 20260624000000_form_visibility.sql — which never actually applied.
-- That same migration also creates forms.form_department_shares (written to when
-- a form's visibility is "departments"), so it is reproduced here too.
--
-- Everything below is idempotent and safe to run repeatedly.

-- 1. Missing columns on forms.forms.
alter table forms.forms
  add column if not exists visibility text not null default 'private'
    check (visibility in ('private', 'org', 'departments', 'public')),
  add column if not exists category text;

-- 2. Department-shares table (used by the "departments" visibility option).
create table if not exists forms.form_department_shares (
  id uuid primary key default gen_random_uuid(),
  form_id uuid not null references forms.forms(id) on delete cascade,
  department text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (form_id, department)
);

alter table forms.form_department_shares enable row level security;

-- Creators and admins can manage shares.
drop policy if exists "Manage department shares" on forms.form_department_shares;
create policy "Manage department shares"
  on forms.form_department_shares
  using (
    form_id in (select id from forms.forms where created_by = auth.uid())
    or (select role from platform.user_profiles where id = auth.uid()) in ('administrator', 'developer')
  );

-- All authenticated users can read shares (the app layer applies the dept filter).
drop policy if exists "Read department shares" on forms.form_department_shares;
create policy "Read department shares"
  on forms.form_department_shares for select
  using (auth.role() = 'authenticated');

-- 3. Force PostgREST to reload its schema cache so the API sees the changes.
notify pgrst, 'reload schema';
