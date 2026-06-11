-- =====================================================================
-- PHASE 4 — Custom fields, cross-section linking, last-updated tracking
-- Foundation for: arbitrary columns on config sections, vendor part #s,
-- ending-balance categories, and "last upload / last edit" stamps.
-- Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- custom_field_definitions — per-section column definitions.
-- Values are stored in each row's `metadata` jsonb, keyed by field_key.
-- Same field_key shared across sections is how cross-section links match.
-- ---------------------------------------------------------------------
create table if not exists custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  section text not null check (section in (
    'locations', 'order_config', 'ending_balance', 'vendor_parts', 'vendors'
  )),
  field_key text not null,         -- stable machine key, e.g. 'area_manager'
  label text not null,             -- display, e.g. 'Area Manager'
  field_type text not null default 'text' check (field_type in ('text', 'number', 'date')),
  position int not null default 0, -- column ordering
  -- Optional cross-section link: pull this field's value from another section
  -- by matching on a shared key (e.g. order_config.area_manager ← locations).
  linked_section text,
  linked_match_key text,           -- field_key used to match rows across sections
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, section, field_key)
);

create index if not exists idx_custom_fields_section
  on custom_field_definitions (company_id, section, position);

alter table custom_field_definitions enable row level security;

drop policy if exists "Company members read custom_field_definitions" on custom_field_definitions;
create policy "Company members read custom_field_definitions"
  on custom_field_definitions for select using (company_id = get_my_company_id());

drop policy if exists "Admins manage custom_field_definitions" on custom_field_definitions;
create policy "Admins manage custom_field_definitions"
  on custom_field_definitions for all
  using (company_id = get_my_company_id() and is_admin())
  with check (company_id = get_my_company_id() and is_admin());

-- ---------------------------------------------------------------------
-- metadata jsonb where missing (locations + vendor_parts already have it)
-- ---------------------------------------------------------------------
alter table location_order_configs   add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table monthly_ending_balances  add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table vendors                  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------
-- vendor_parts — distinguish vendor part # from our part #
-- (existing `part_number` is treated as the Vendor Part Number)
-- ---------------------------------------------------------------------
alter table vendor_parts add column if not exists our_part_number text;

-- ---------------------------------------------------------------------
-- Last-upload / last-edit tracking on config tables.
-- updated_at is auto-touched by a trigger; the app sets updated_by +
-- last_change_source ('upload' | 'manual') on writes.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'locations', 'vendors', 'vendor_parts', 'product_id_mappings', 'global_products',
    'location_order_configs', 'monthly_ending_balances'
  ] loop
    execute format('alter table %I add column if not exists updated_by uuid references auth.users on delete set null', t);
    execute format('alter table %I add column if not exists last_change_source text', t);
  end loop;
end $$;

-- Auto-touch updated_at on any UPDATE
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'locations', 'vendors', 'vendor_parts', 'product_id_mappings', 'global_products',
    'location_order_configs', 'monthly_ending_balances'
  ] loop
    execute format('drop trigger if exists trg_touch_updated_at on %I', t);
    execute format('create trigger trg_touch_updated_at before update on %I for each row execute function touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- REALTIME — live column-definition + config updates
-- ---------------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table custom_field_definitions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table locations; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table monthly_ending_balances; exception when duplicate_object then null; end $$;
