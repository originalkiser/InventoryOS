-- =====================================================================
-- PHASE 8 — Unit-of-measure conversion (ported from order-generator)
-- A UoM mapping table (on-hand unit → order unit factor) plus a per-product
-- order unit so the order engine can convert on-hand quantities into order
-- quantities. Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- uom_mappings — factor to convert `from_unit` (on-hand) into `to_unit`
-- (order). e.g. EA → CS factor 0.0833 means 12 EA = 1 CS.
-- ---------------------------------------------------------------------
create table if not exists uom_mappings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  from_unit text not null,
  to_unit text not null,
  factor numeric not null default 1,
  updated_by uuid references auth.users on delete set null,
  last_change_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, from_unit, to_unit)
);

create index if not exists idx_uom_mappings_company on uom_mappings (company_id);

alter table uom_mappings enable row level security;

drop policy if exists "Company members read uom_mappings" on uom_mappings;
create policy "Company members read uom_mappings"
  on uom_mappings for select using (company_id = get_my_company_id());

drop policy if exists "Admins manage uom_mappings" on uom_mappings;
create policy "Admins manage uom_mappings"
  on uom_mappings for all
  using (company_id = get_my_company_id() and is_admin())
  with check (company_id = get_my_company_id() and is_admin());

-- Realtime (guarded — adding a table already in the publication errors).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'uom_mappings'
  ) then
    alter publication supabase_realtime add table uom_mappings;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- global_products.order_uom — the unit this product is ORDERED in.
-- unit_of_measure stays the on-hand unit; a uom_mapping between the two
-- supplies the conversion factor.
-- ---------------------------------------------------------------------
alter table global_products add column if not exists order_uom text;
