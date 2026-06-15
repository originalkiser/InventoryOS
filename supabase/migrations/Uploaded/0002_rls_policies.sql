-- Enable RLS on all tables

alter table companies enable row level security;
alter table profiles enable row level security;
alter table locations enable row level security;
alter table vendors enable row level security;
alter table vendor_parts enable row level security;
alter table product_id_mappings enable row level security;
alter table global_products enable row level security;
alter table location_order_configs enable row level security;
alter table monthly_ending_balances enable row level security;
alter table data_source_links enable row level security;
alter table monthly_counts enable row level security;
alter table monthly_count_products enable row level security;
alter table recount_requests enable row level security;
alter table recount_config enable row level security;
alter table weekly_counts enable row level security;
alter table order_sessions enable row level security;
alter table order_line_items enable row level security;
alter table issue_categories enable row level security;
alter table issue_statuses enable row level security;
alter table issues enable row level security;
alter table schedule_events enable row level security;

-- Helper function: get current user's company_id
create or replace function get_my_company_id()
returns uuid language sql security definer stable as $$
  select company_id from profiles where id = auth.uid()
$$;

-- Helper function: is current user an admin?
create or replace function is_admin()
returns boolean language sql security definer stable as $$
  select role = 'admin' from profiles where id = auth.uid()
$$;

-- =====================
-- PROFILES
-- =====================
create policy "Users can view own profile"
  on profiles for select using (id = auth.uid());

create policy "Users can update own profile"
  on profiles for update using (id = auth.uid());

create policy "Users can view teammates"
  on profiles for select using (company_id = get_my_company_id());

-- =====================
-- COMPANIES
-- =====================
create policy "Users can view own company"
  on companies for select using (id = get_my_company_id());

create policy "Admins can update company"
  on companies for update using (id = get_my_company_id() and is_admin());

-- =====================
-- LOCATIONS (admin write, all read within company)
-- =====================
create policy "Company members can read locations"
  on locations for select using (company_id = get_my_company_id());

create policy "Admins can insert locations"
  on locations for insert with check (company_id = get_my_company_id() and is_admin());

create policy "Admins can update locations"
  on locations for update using (company_id = get_my_company_id() and is_admin());

create policy "Admins can delete locations"
  on locations for delete using (company_id = get_my_company_id() and is_admin());

-- =====================
-- VENDORS
-- =====================
create policy "Company members can read vendors"
  on vendors for select using (company_id = get_my_company_id());

create policy "Admins can manage vendors"
  on vendors for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- VENDOR PARTS
-- =====================
create policy "Company members can read vendor_parts"
  on vendor_parts for select using (company_id = get_my_company_id());

create policy "Admins can manage vendor_parts"
  on vendor_parts for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- PRODUCT ID MAPPINGS
-- =====================
create policy "Company members can read product_id_mappings"
  on product_id_mappings for select using (company_id = get_my_company_id());

create policy "Admins can manage product_id_mappings"
  on product_id_mappings for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- GLOBAL PRODUCTS
-- =====================
create policy "Company members can read global_products"
  on global_products for select using (company_id = get_my_company_id());

create policy "Admins can manage global_products"
  on global_products for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- LOCATION ORDER CONFIGS
-- =====================
create policy "Company members can read location_order_configs"
  on location_order_configs for select using (company_id = get_my_company_id());

create policy "Admins can manage location_order_configs"
  on location_order_configs for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- MONTHLY ENDING BALANCES
-- =====================
create policy "Company members can read monthly_ending_balances"
  on monthly_ending_balances for select using (company_id = get_my_company_id());

create policy "Admins can manage monthly_ending_balances"
  on monthly_ending_balances for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- DATA SOURCE LINKS
-- =====================
create policy "Company members can read data_source_links"
  on data_source_links for select using (company_id = get_my_company_id());

create policy "Admins can manage data_source_links"
  on data_source_links for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- MONTHLY COUNTS
-- =====================
create policy "Company members can read monthly_counts"
  on monthly_counts for select using (company_id = get_my_company_id());

create policy "Company members can insert monthly_counts"
  on monthly_counts for insert with check (company_id = get_my_company_id());

create policy "Admins can manage monthly_counts"
  on monthly_counts for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- MONTHLY COUNT PRODUCTS
-- =====================
create policy "Company members can read monthly_count_products"
  on monthly_count_products for select using (company_id = get_my_company_id());

create policy "Company members can insert monthly_count_products"
  on monthly_count_products for insert with check (company_id = get_my_company_id());

-- =====================
-- RECOUNT REQUESTS
-- =====================
create policy "Company members can read recount_requests"
  on recount_requests for select using (company_id = get_my_company_id());

create policy "Company members can manage recount_requests"
  on recount_requests for all using (company_id = get_my_company_id());

-- =====================
-- RECOUNT CONFIG
-- =====================
create policy "Company members can read recount_config"
  on recount_config for select using (company_id = get_my_company_id());

create policy "Admins can manage recount_config"
  on recount_config for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- WEEKLY COUNTS
-- =====================
create policy "Company members can read weekly_counts"
  on weekly_counts for select using (company_id = get_my_company_id());

create policy "Company members can insert weekly_counts"
  on weekly_counts for insert with check (company_id = get_my_company_id());

create policy "Admins can manage weekly_counts"
  on weekly_counts for all using (company_id = get_my_company_id() and is_admin());

-- =====================
-- ORDER SESSIONS
-- =====================
create policy "Company members can read order_sessions"
  on order_sessions for select using (company_id = get_my_company_id());

create policy "Company members can manage order_sessions"
  on order_sessions for all using (company_id = get_my_company_id());

-- =====================
-- ORDER LINE ITEMS (via order_sessions join)
-- =====================
create policy "Company members can read order_line_items"
  on order_line_items for select
  using (
    exists (
      select 1 from order_sessions os
      where os.id = order_line_items.order_session_id
        and os.company_id = get_my_company_id()
    )
  );

create policy "Company members can manage order_line_items"
  on order_line_items for all
  using (
    exists (
      select 1 from order_sessions os
      where os.id = order_line_items.order_session_id
        and os.company_id = get_my_company_id()
    )
  );

-- =====================
-- ISSUE CATEGORIES
-- =====================
create policy "Company members can read issue_categories"
  on issue_categories for select using (company_id = get_my_company_id());

create policy "Company members can manage issue_categories"
  on issue_categories for all using (company_id = get_my_company_id());

-- =====================
-- ISSUE STATUSES
-- =====================
create policy "Company members can read issue_statuses"
  on issue_statuses for select using (company_id = get_my_company_id());

create policy "Company members can manage issue_statuses"
  on issue_statuses for all using (company_id = get_my_company_id());

-- =====================
-- ISSUES
-- =====================
create policy "Company members can read issues"
  on issues for select using (company_id = get_my_company_id());

create policy "Company members can manage issues"
  on issues for all using (company_id = get_my_company_id());

-- =====================
-- SCHEDULE EVENTS
-- =====================
create policy "Company members can read schedule_events"
  on schedule_events for select using (company_id = get_my_company_id());

create policy "Company members can manage schedule_events"
  on schedule_events for all using (company_id = get_my_company_id());
