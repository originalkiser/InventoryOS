# InventoryOS — Claude Code Instructions

## Project overview

InventoryOS is an internal Strickland Brothers operating platform. It consolidates and replaces numerous third-party SaaS tools. Modules cover inventory counting, ordering, location management (lookup, tank monitors, AM/RD lookup, exception reporting, location comms), outlier reporting, meeting notes, forms, marketing campaign planning, project task tracking, EOD review workflows, scheduling, month-end processing, department-scoped access control, and integrations (Monday.com, OneDrive, Azure/Microsoft sign-in, Droptop).

- **Repo:** https://github.com/originalkiser/InventoryOS
- **Branch:** `main`
- **Stack:** React 18 + TypeScript 5 + Vite 5 + TailwindCSS 3 + Supabase JS v2
- **Build:** `tsc && vite build` — TypeScript errors are CI failures
- **Dev server:** `npm run dev`
- **Tests:** `npm run test` (Vitest)

---

## Claude Code operating rules

1. **Make targeted changes only.** Read the files directly relevant to the task. Do not scan the whole repo.
2. **Inspect before editing.** Always read a file before modifying it.
3. **Reuse existing patterns.** Match the code style, component library, and hook patterns already in the file.
4. **No unrelated refactors.** Do not clean up, rename, or restructure code outside the task scope.
5. **No new dependencies without approval.** All additions to `package.json` require explicit user confirmation.
6. **No new hex colors.** Use existing Tailwind tokens only (see Brand section).
7. **Include loading and error states** in any new data-fetching UI.
8. **State files inspected and files changed** at the end of every response (see Final Response Format).
9. **Avoid `.schema('public')`** — PostgREST does not support the `Accept-Profile: public` header. Use bare `supabase.from()` only for truly public-schema tables (none currently exist in this app). All app tables use named schemas.

---

## Task execution workflow

For every task:

1. Restate the objective in one sentence.
2. Identify the smallest likely file scope before reading files.
3. Inspect only the files needed for that scope.
4. If the task touches database writes, identify the schema/table/columns before editing.
5. If the task touches UI, identify the existing component/style pattern before editing.
6. Make the smallest safe change.
7. Run or recommend the narrowest relevant validation:
   - TypeScript/build check for code changes
   - targeted test if one exists
   - manual UI test steps if no test exists
8. Do not continue expanding scope after the original task is complete.

If a task is ambiguous, make a conservative assumption and list it under Risks / assumptions instead of scanning broadly.

---

## Token-efficiency rules

- Do not read large files unless required.
- Do not open every file in a directory just to understand a feature.
- Prefer targeted searches for function names, table names, route names, component names, or schema names.
- Summarize findings instead of pasting long code blocks back to the user.
- When proposing a plan, keep it brief and implementation-focused.
- When blocked, state the specific missing detail instead of exploring unrelated files.

---

## Repository structure

```
inventoryos/
├── index.html
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
├── HANDOFF.md                     # session handoff notes
├── OrderGen-PORT-NOTES.md         # order generation porting notes
├── .env                           # Supabase URL + anon key (never commit secrets)
├── public/
├── supabase/
│   ├── config.toml
│   ├── functions/                 # Edge Functions (invite-user, archive-old-orders, etc.)
│   └── migrations/                # SQL migrations — Uploaded/ = applied; root = may be pending
└── src/
    ├── App.tsx
    ├── main.tsx
    ├── index.css                  # CSS variables for brand tokens + font imports
    ├── assets/fonts/              # Chakra Petch + DM Mono font files
    ├── components/
    │   ├── layout/                # AppShell, Sidebar, TopBar
    │   ├── ui/                    # Button, Modal, Tabs, Input, Select, Badge, Toggle, Combobox
    │   ├── shared/                # DataTable, FloatingPanel, CustomColumnBuilder, LinksCell, etc.
    │   ├── config/                # ClearTableButton, ConfigUpload, CustomFieldsEditor
    │   ├── integrations/          # LocationSyncPanel, MonthEndPullPanel, PlacedOrdersTable
    │   ├── inventory/             # InventoryOverlay, InventoryView, InventoryNavBar, InventoryShortcuts
    │   └── upload/                # FileUploadZone, ColumnMapper, DataSourceLinker
    ├── hooks/                     # useAuth, useTable, useDarkMode, useSidebarPrefs, useFeatureAccess, etc.
    ├── lib/                       # supabase.ts, roles.ts, orderEngine.ts, recountEngine.ts, transforms.ts, etc.
    ├── modules/
    │   ├── admin/                 # UsersPage (users, departments, feature access), InviteUserModal
    │   ├── comms/                 # LocationCommsPage, LocationCommsModal, useCommsConfig
    │   ├── config/
    │   │   ├── GlobalConfigPage.tsx
    │   │   ├── ConfigPage.tsx
    │   │   └── tabs/              # LocationsTab, VendorPartsTab, OrderConfigTab, ProductMappingTab,
    │   │                          #   GlobalProductsTab, PosLocationMapTab, CompanyHolidaysTab
    │   ├── dev-hub/               # DevHubPage
    │   ├── exceptions/            # ExceptionReportingPage, ExceptionReportModal, useExceptionConfig
    │   ├── feature-requests/
    │   ├── forms/                 # FormBuilderPage, FormsListPage, FormAssignmentsPage, FormResultsPage
    │   ├── inventory/             # InventoryAlertsPage
    │   ├── issues/                # IssuesPage, IssueFormModal
    │   ├── locations/             # LocationsPage, LocationLookupPage/Overlay, AmRdLookupPage,
    │   │                          #   TankMonitorsPage, TankEmailModal, TankProductMapping,
    │   │                          #   LocationDataSourceConfig, MapRoutesTab
    │   ├── marketing/             # MarketingPlannerPage, modals/, tabs/ (campaign planning)
    │   ├── meetings/              # MeetingNotesPage
    │   ├── monthend/              # MonthEndPage, CountsTab, RecountsTab, RecountLogicTab, etc.
    │   ├── operations/
    │   │   └── outlier/           # OutlierShell, pages/ (ReportViewPage, AMDashboardPage, etc.)
    │   ├── orders/                # OrdersPage, NewOrderTab, OrderHistoryTab, MinRulesTab, ProfilesTab
    │   ├── projects/              # ProjectsModule, EndDayModal
    │   ├── schedule/              # SchedulePage, ScheduleEventModal
    │   ├── tasks/                 # TasksPage
    │   └── weekly/                # WeeklyPage
    ├── pages/                     # Dashboard, Login, OnHandPage, OrderConfig, OrderHistory, Setup, etc.
    ├── services/                  # mondayService, droptopService, orderConfigService
    ├── stores/                    # authStore, monthEndStore, orderStore, weeklyStore (Zustand)
    ├── types/                     # database.ts, forms.ts, index.ts, integrations.ts, marketing.ts
    └── utils/                     # monthEndUtils.ts, orderNumberUtils.ts
```

**Migration status:** Files under `supabase/migrations/Uploaded/` are applied to production. Files in `supabase/migrations/` root may be pending — but root is not a reliable signal either: several root migrations (e.g. `20260817_forms_visibility_reapply.sql`) exist specifically because an earlier migration was written but never actually ran in production, and root files do get applied and then left in place. Do not infer applied/pending status from file location alone — if a feature depends on a specific column and it matters, verify empirically (query the column, or check whether recent commits reference save failures for it) rather than assuming. Default to the decoupled save pattern below for any new/recently-added column.

---

## Supabase architecture

The app uses **multiple Postgres schemas**. Never call `supabase.from()` for cross-schema tables — always use the cast pattern:

```ts
const sb = supabase as any
sb.schema('inventory').from('table_name')
sb.schema('core').from('table_name')
sb.schema('platform').from('table_name')
sb.schema('outlier').from('table_name')
sb.schema('forms').from('table_name')
sb.schema('marketing').from('table_name')
```

### Schema map

| Schema | Contains |
|--------|----------|
| `inventory` | counts, thresholds, orders, order_profiles, order_sessions, meeting_notes, projects, project_tasks, monthly_ending_balances, recount_requests/recount_product_snapshots, tank_monitors, droptop_sync_log, location_order_config, location_comms, exception_reports, exception_issue_option, global_products, product_id_mappings, uom_mappings, product_usage, **vendors**, **vendor_parts**, issue_categories/issue_statuses/issue_tracker_columns/issue_custom_values (issue *config*, not the issues themselves — see `platform.issues` below), field_definitions, data_source_links |
| `core` | **locations**, **tasks** (standalone user tasks — moved out of `inventory`), user_sidebar_prefs, user_feature_access, location_exclusions, location_supplemental, pos_location_map, company_holidays |
| `platform` | user_profiles, **issues** (moved out of `inventory`, now department-scoped), departments, user_department_memberships, schedule_events, event_checklist_items, app_settings, custom_columns/custom_values, attachments |
| `outlier` | report system: reports, report_entries, weeks, departments |
| `forms` | form builder + submissions: forms, fields, field_conditions, condition_rules, submissions, responses, assignments, score_streaks, form_department_shares |
| `marketing` | campaign planning: campaign_templates, campaign_template_tasks, monthly_plans, campaign_assignments, campaign_tasks |
| `archive` | `deleted_rows` — every deleted row (as jsonb) from tables whose ids other records reference. Written only by an `AFTER DELETE` trigger; see below. |

**Deleted-row archive (`archive.deleted_rows`, migration `20260819_archive_deleted_rows.sql`):**
Cross-table references in this app are plain `uuid` columns with **no foreign keys**, so deleting a row (or clearing + re-uploading a table, which is a delete plus brand-new ids) silently orphans everything pointing at it — no error, it just stops matching. An `AFTER DELETE` trigger copies the full pre-delete row into `archive.deleted_rows` for the tables that carry that risk (`core.locations`, `core.pos_location_map`, `inventory.vendors`/`vendor_parts`/`issue_statuses`/`issue_categories`, `platform.departments`). Restore recipes are in the migration file's trailing comment — including the important case where rows were re-created under new ids, where the archive is used as an old-id → business-key map to repoint orphans rather than to re-insert. **When adding a table that other records will reference by id, add it to that trigger list.**

**Gotchas from recent schema moves — don't assume the old location:**
- `tasks` (standalone tasks) is in **`core`**, not `inventory`. `project_tasks` (project-scoped) is still in `inventory`.
- `issues` is in **`platform`**, not `inventory`. The issue *config* tables (`issue_statuses`, `issue_categories`, `issue_tracker_columns`, `issue_custom_values`) stayed in `inventory`.
- `exception_reports`/`location_comms` are separate but linked tables in `inventory` — a Location Comms row with `comm_type = 'Exception Reporting'` writes an `exception_reports` row too and stores its id in `exception_report_id`.
- `vendors` and `vendor_parts` moved from `core` to **`inventory`** (migration `20260818d_move_vendors_to_inventory.sql`) to match everything else they relate to (`global_products`, `uom_mappings`, `location_order_config`, `product_usage`). Before this move, a `.schema('inventory').from('vendor_parts')` query returned zero rows with no error rather than failing loudly, which let a real feature (Product Usage's vendor-part-number import) stay silently broken until caught manually — if you ever see a cross-schema table query return an empty result where you expected data, verify the schema against the file that actually owns/CRUDs that table before trusting this doc.
- `uom_mappings` moved from `core` to **`inventory`** (migration `20260821_orders_v2_uom_cost.sql`) — the *same* bug as the `vendor_parts` move above, on a different table: it was created in the original pre-schema-split `core` batch and never actually moved when `vendors`/`vendor_parts` did, despite the 20260818d migration's own comment claiming it was already in `inventory`. Nobody had verified it because the table was always empty, so the silent-zero-rows failure never surfaced. If a table's real schema location matters and it's unverified, query `information_schema.tables` rather than trusting this doc or a prior migration's comment.

---

## Roles & department access

Roles (`src/lib/roles.ts`): `developer`, `administrator`, `area_manager`, `director`, `department_user` (legacy `admin`/`user` still handled for display).

- `isAdminOrDeveloper(role)` — developer/administrator/admin only.
- `department_user` role is scoped to specific departments via `platform.departments` + `platform.user_department_memberships`. `useDeptAccess()` (`src/hooks/useDeptAccess.ts`) returns the set of allowed sidebar section slugs (`inventory`, `operations`, `marketing`, `finance`, `accounting`, `project_management`) for the current user, or `null` if unrestricted. `App.tsx`'s `SmartRedirect`/`DEPT_FIRST_ROUTE` sends department users to their first allowed section.
- Manage departments/memberships in `src/modules/admin/UsersPage.tsx`.

---

## `platform.user_profiles` — critical rules

- **Email column is `email`**, not `work_email`
- **Active users:** filter with `.is('deleted_at', null)` — **never** `.eq('is_active', true)` (column does not exist)
- `user_profiles.id` IS the auth user ID — no separate join needed
- `preferences` (jsonb, migration `20260815_user_preferences.sql`) backs cross-device UI prefs via `useProfilePrefs` — dark mode, nav order, dashboard shortcuts, FAB state, hidden sidebar sections, Location Lookup panel view. Falls back to localStorage-only if the column is missing.
- New profile columns (`auto_push_tasks`, `skip_weekends_holidays`, `blocked_days`) may not exist in production until migration `20260628_eod_holidays.sql` is applied

```ts
const { data, error } = await (supabase as any)
  .schema('platform')
  .from('user_profiles')
  .select('id, full_name, email')
  .eq('company_id', profile.company_id)
  .is('deleted_at', null)
  .order('full_name')
```

---

## Brand and UI rules

Palette from `tailwind.config.ts` — CSS-variable-backed for dark mode:

| Token | Hex | Usage |
|-------|-----|-------|
| `navy` | `#002745` | Primary bg, nav, table headers, buttons |
| `inky` | `#4F7489` | Secondary text, inactive, muted |
| `sky` | `#B7E0DE` | Highlight, hover, focus ring, active accent |
| `cream` | `#F2F1E6` | Page bg, card surfaces |
| `onyx` | `#000000` | Sparingly |

**Allowed off-palette only:**
- `#C0392B` / `sb-red` — danger/critical red
- `#2ECC71` / `sb-green` — inventory flag green
- `#E67E22` / `sb-orange` — inventory flag orange

**Rules:**
- Never introduce new hex values
- Use Tailwind tokens (`text-navy`, `bg-cream`, `border-sky/30`, etc.)
- Fonts: `font-heading` = Chakra Petch, `font-body` / `font-mono` = DM Mono
- Reuse `src/components/ui/` primitives (Button, Modal, Tabs, Input, Badge, Toggle)
- Operational tables should be **dense and readable** — avoid excessive padding
- Always include loading and error states in data-fetching components
- Toast notifications: `import toast from 'react-hot-toast'` → `toast.success()` / `toast.error()`

---

## Database schema reference

### `core.locations`
`id, company_id, location_code, name, region, active, metadata (jsonb), order_date, district, monday_item_id (nullable, unique), raw_monday_data, last_synced_at, created_at, updated_at, updated_by, last_change_source`

- `metadata` may contain: `owner`, `market`, `area_manager`, `regional_director`, `director`, `type`
- `meta:regional_director` may fall back to `meta:director` in display code
- `monday_item_id` is used for Monday.com sync; `raw_monday_data` stores the source payload

### `inventory.vendors`
`id, company_id, vendor_code, name, metadata, created_at, updated_at, updated_by, last_change_source`

### `inventory.vendor_parts`
`id, company_id, vendor_id, part_number, our_part_number, description, unit_of_measure, package_type, bulk_minimum, individual_minimum, metadata, created_at, updated_at, updated_by, last_change_source`

### `inventory.global_products`
`id, company_id, product_id, unit_of_measure, order_uom, package_type, bulk_minimum, individual_minimum, created_at, updated_at, updated_by, last_change_source`

### `inventory.uom_mappings`
`id, company_id, from_unit, to_unit, factor, created_at, updated_at, updated_by, last_change_source`

### `core.pos_location_map`
`id, company_id, pos_string, location_id, created_at, updated_at, updated_by, last_change_source`

> Note: this table is in `core`, not `inventory`.

### `inventory.uom_thresholds`
`uom, trigger_qty, min_order_qty, display_label, updated_at`

### `inventory.location_sync_log`
`id, synced_at, records_updated, records_added, records_deactivated, status, error_message`

### `core.user_sidebar_prefs`
`id, user_id, section_order, section_collapsed, item_order, favorites, utility_nav_order, outlook_sync_enabled, outlook_sync_scope, column_visibility, updated_at`

### `core.user_feature_access`
`id, user_id, feature_key, enabled, granted_by, granted_at`

### `core.company_holidays`
`id, company_id, date, name, created_by, created_at` (unique on `company_id, date`)

### `inventory.location_data_source`
`id, source_type, monday_board_id, monday_name_column, monday_code_column, monday_region_column, monday_market_column, monday_status_filter, azure_container_path, sync_schedule, last_synced_at, last_sync_count, updated_by, updated_at`

### `inventory.exception_reports`
`id, company_id, location_id, area_manager, date_of_finding, date_of_shop_action, report_type ('PO Match'|'Activity'|'Current On Hand'), issue, details, contacted (bool), contacted_date, response, rd_if_no, response_notes, status, metadata (jsonb), updated_by, last_change_source, created_at, updated_at`

- Config (report types, per-type issue options, response-days default) lives in `platform.app_settings` key `exception_config` via `useExceptionConfig` — **not** in `inventory.exception_issue_option` (that table exists but is unused; defaults live in code).
- Written from both the Exception Reporting page (`src/modules/exceptions/`) and the Location Lookup "Exceptions" box, and from Location Comms when `comm_type = 'Exception Reporting'`.

### `inventory.location_comms`
`id, company_id, location_id, comm_date, contact_method, email_subject, who_contacted, comm_type ('Product Request'|'Exception Reporting'|custom), products (jsonb array), action_taken, exception_report_id (nullable, set for Exception Reporting rows), status, notes, metadata, updated_by, last_change_source, created_at, updated_at`

- Config (contact methods, who-contacted, comm types, action-taken options) lives in `platform.app_settings` key `comms_config` via `useCommsConfig`.
- `LocationCommsPage.tsx` does its own direct query (not `useConfigTab`) because the modal multi-writes `exception_reports` + `location_comms` together.

### `inventory.tank_monitors` (extended fields)
Base tracked columns: `value, unit, product_id, keep_fill, on_hand, inventory_time, reading_date`. Extended (migration `20260815_tank_monitor_fields.sql`): `volume_alarm_status, key_note, battery_pct, serial_rtu_id, system_tank_id, level_inches, low_set_point_pct, height, source_location, available_capacity` and a generated `total_capacity` (`on_hand + available_capacity`, stored). `source_location` holds the raw uploaded shop string for monitors not yet matched to a `core.locations` row.

### `platform.departments` / `platform.user_department_memberships`
`departments`: `id, company_id, name, slug, sort_order, created_at, created_by` — seeded with `inventory`, `operations`, `marketing`, `finance`, `accounting`, `project_management` per company. `user_department_memberships`: `id, user_id, department_id, company_id, created_at, created_by`. Drive `department_user` role scoping — see Roles & department access above.

### `platform.issues`
Moved from `inventory.issues`; adds `department_id` (references `platform.departments`). `inventory.issue_statuses`, `inventory.issue_categories`, `inventory.issue_tracker_columns`, `inventory.issue_custom_values` remain in `inventory` and still join by issue id.

### `marketing.*` (campaign planning)
`campaign_templates` (company_id, name, category, description, is_active, sort_order) → `campaign_template_tasks` (per-template checklist) → `monthly_plans` (company_id, location_id, plan_month, plan_year, unique per location/month/year) → `campaign_assignments` (plan + template, snapshots name/category at assignment time) → `campaign_tasks` (assignment + template task, snapshots name/description, status: not_started/in_progress/complete/blocked/not_applicable). Assignments/tasks **snapshot** the template text at creation time so later template edits don't retroactively change existing plans.

---

## Defensive migration / decoupled save pattern

Some migration files in the repo root may not yet be applied to production. When a feature depends on a column that might be missing:

1. Save core required fields first — show error toast on failure and return
2. Save optional / new-column data as fire-and-forget best-effort
3. Never let a missing optional column break the whole workflow

```ts
const { error } = await sb.schema('x').from('table')
  .update({
    core_column: value,
    updated_at: new Date().toISOString(),
  })
  .eq('id', id)

if (error) {
  toast.error('Unable to save changes')
  return
}

// best-effort: new column that may not exist in production yet
sb.schema('x').from('table')
  .update({ new_column: value })
  .eq('id', id)
  .then(() => {})
```

**Files using this pattern:**
- `src/modules/operations/outlier/pages/ReportViewPage.tsx` — AM/RDO assignment columns
- `src/modules/meetings/MeetingNotesPage.tsx` — `links` column on `inventory.meeting_notes`
- `src/components/layout/Sidebar.tsx` — new profile columns (`auto_push_tasks`, etc.)
- `src/hooks/useProfilePrefs.ts` — `platform.user_profiles.preferences` (falls back to localStorage-only)
- `src/modules/tasks/TasksPage.tsx` — `core.tasks.target_date_end`
- `src/modules/schedule/ScheduleEventModal.tsx` — `platform.schedule_events.color`/`checklist_lead_days`, `platform.event_checklist_items.start_offset_days`/`end_offset_days`
- `src/modules/locations/LocationLookupPage.tsx` / config tabs — `core.location_supplemental` reads (best-effort/guarded)

---

## Module notes

### Outlier reporting — `src/modules/operations/outlier/`

Key files:
- `pages/ReportViewPage.tsx` — paste report data, comment, AM/RDO name + user assignment
- `pages/AMDashboardPage.tsx` — area manager view, assigned items, comment/complete
- `pages/LeadershipPage.tsx` — leadership overview
- `pages/DepartmentPage.tsx` — department-level view
- `types.ts` — `Report`, `ReportEntry`, `Week`, `UserProfile`, `AMLocation`

AM/RDO assignment: `area_manager_name` / `rdo_name` are core columns (always saved). `am_assigned_user_id` / `rdo_assigned_user_id` are best-effort (new columns, migration may be pending). Preserve this separation when editing save logic.

AM Dashboard header shows: assigned item count + "N needs attention" (orange) for entries without comment and not complete.

### Locations — `src/modules/locations/`

- `LocationsPage.tsx` — quick access page with cascading filter dropdowns
- `LocationLookupPage.tsx` / `LocationLookupOverlay.tsx` — per-shop detail view (route `/location-lookup`): picker + sidebar fields + tank monitors + order configs by vendor + issues/exceptions/comms boxes + supplemental data. Floating-panel version supports dnd-kit column management and is shareable as a block.
- `AmRdLookupPage.tsx` — route `/am-rd-lookup`; AM/RD-focused rollup pulling `location_order_config`, `vendors`, `issues`, `issue_statuses`, `location_comms`, `tank_monitors`.
- `TankMonitorsPage.tsx` — route `/tank-monitors`; all/offline/low-VMI views, serial-based overwrite (no daily history), self-healing dedupe by serial, Manage Columns, email workflow (`TankEmailModal.tsx`, `TankEmailTemplates.tsx`, `tankEmail.ts`) with a per-template "VMI/keepfill only" toggle.
- `TankProductMapping.tsx` — maps tank monitor products to `inventory.vendor_parts`.
- `LocationDataSourceConfig.tsx` — Monday.com / Azure source config.
- `MapRoutesTab.tsx` / `ManualRouteModal.tsx` — route mapping (migration `20260702_location_routes.sql`).

Filter hierarchy: `meta:owner` → `region` → `meta:market` → `meta:area_manager` → `meta:regional_director` (falls back to `meta:director`). Apply filters **before** passing data to `useTable()`.

`locFieldValue(loc, field)` reads base fields directly or `meta:X` from `loc.metadata[X]`.

Per-user location exclusions (`core.location_exclusions`, `src/hooks/useLocationExclusions.ts`) filter listings/dashboards for a given user — apply after the standard filter hierarchy, before `useTable()`.

Config tab: `src/modules/config/tabs/LocationsTab.tsx` (uses `useConfigTab` hook).

### Exception Reporting — `src/modules/exceptions/`

Separate from `platform.issues` — tracks a specific inventory finding workflow (PO Match / Activity / Current On Hand) through shop contact → response → resolution. `exceptions.ts` holds types + `REPORT_TYPES`/`DEFAULT_ISSUES`/`EXCEPTION_STATUSES` + `parseContacted`. Page is Tabs [Reports/Summary/Settings]: Reports is a bespoke inline-editable table (not `useConfigTab`) with sticky Status+Shop columns, a pencil→modal for full edit, status filter chips, and a "More" popup for details/response notes. Settings tab holds the Excel upload + config editing (via `useExceptionConfig`, `platform.app_settings` key `exception_config`). The same table backs the Location Lookup "Exceptions" box — keep both write paths in sync when editing save logic.

### Location Comms — `src/modules/comms/`

Log of shop/AM contacts. Two branches in `LocationCommsModal.tsx`: **Product Request** (products pulled from `location_order_config` for configured items, `product_usage` for non-configured; on-hand/days-of-supply read directly from `product_usage.days_of_supply`, not computed) and **Exception Reporting** (upserts an `exception_reports` row, stores its id back on the comms row). Contact method / who / type / action-taken are add-to-list combos backed by `comms_config` (`useCommsConfig`). Sidebar item + route `/location-comms`, plus a "Comms" box on Location Lookup.

### Marketing Planner — `src/modules/marketing/`

Campaign planning module, own `marketing` schema (see Database schema reference). `MarketingPlannerPage.tsx` with tabs (`MonthlyPlansTab`, `ExecutionTab`, `CampaignTemplatesTab`, `ReportingTab`) and modals (`NewPlanModal`, `PlanDetailModal`, `ExecutionDetailModal`, `ImportPlansModal`). Route `/marketing-planner`; first-landing route for `department_user`s scoped to the `marketing` department. Assignments/tasks snapshot template text at creation — editing a template does not retroactively change plans already assigned from it.

### Departments & role-based access — `src/modules/admin/UsersPage.tsx`

Admins manage per-user `role`, department memberships (`platform.user_department_memberships`), and per-feature access (`core.user_feature_access`, checked via `useFeatureAccess`). See Roles & department access above for how `department_user` scoping works end-to-end.

### Config tabs — `src/modules/config/tabs/`

All config tabs use the `useConfigTab<T>(tableName, schemaName)` hook from `src/modules/config/useConfigTab.ts`. The hook handles pagination, caching (5-min TTL), batch upsert, and schema routing automatically. Pass `'public'` to use bare `supabase.from()`; any other schema name uses `.schema(name).from()`.

### Forms — `src/modules/forms/FormBuilderPage.tsx`

`LocationSeeder` component seeds location groups into a form field from location metadata. Supports undo of last seed. Groups are built from `metadata` via `useMemo`. Preserve `LocationSeeder` behavior when editing form builder code.

### Meeting notes — `src/modules/meetings/MeetingNotesPage.tsx`

Core meeting fields save first. `links` (array of `{ label, url }`) is best-effort — silently dropped if the column doesn't exist. Do not merge links into the core save object.

### Orders — `src/modules/orders/`

Uses `src/lib/orderEngine.ts`. Key tabs: `NewOrderTab`, `OrderHistoryTab`, `MinRulesTab`, `ProfilesTab`. See ordering business rules section below.

### Projects / EOD — `src/modules/projects/`

`EndDayModal.tsx` exports `nextWorkday(skipWeekends, holidays, blockedDays)` utility used by `TopBar.tsx`. TopBar polls every 60s to fire EOD prompt at configured time. End Day button glows orange when past EOD time and not yet reviewed (`eod_reviewed_${YYYY-MM-DD}` localStorage key).

---

## Ordering logic — business rules

### Order date
- Order date = delivery day minus **3 business days** (excluding weekends)
- Thursday delivery → Monday order
- Monday delivery → Wednesday order
- Do **not** add holiday skipping to order date logic unless explicitly requested

### Product/order quantity
- Products may have `bulk_minimum`, `individual_minimum`, `unit_of_measure`, `order_uom`, `package_type`
- Use `global_products`, `vendor_parts`, `uom_mappings`, and `uom_thresholds` together when computing order quantities
- Do not assume all products order in the same unit of measure

### Keep-fill / VMI logic
- Keep-fill products must **not** be included in normal generated orders
- Use tank monitor data to estimate on-hand quantity when available
- If tank monitor data is unavailable, show an exception / needs-review state — never silently include or silently exclude
- Generate a side order, alert, or vendor notification recommendation
- Keep-fill logic must be visible and transparent to the user

---

## Integrations roadmap

### Monday.com API
- Sync location records using `monday_item_id` as the stable external key
- Store source payload in `raw_monday_data`; update `last_synced_at`
- Log sync results to `inventory.location_sync_log`
- Do **not** overwrite manually maintained fields unless explicitly intended
- Preserve all audit fields (`updated_by`, `last_change_source`)

### Azure OAuth / Microsoft sign-in
- Add "Sign in with Microsoft" without breaking existing Supabase email auth
- Do **not** hard-code tenant IDs, client IDs, or secrets — use environment variables
- Document redirect URI requirements in code comments or `.env.example`

### OneDrive daily table updates
- Treat OneDrive files as external source data
- Do **not** overwrite user-edited app data without an explicit conflict rule
- Store file/source metadata when practical
- Prefer import logs for traceability (`location_sync_log` or equivalent)

### Droptop integration — `src/services/droptopService.ts`
- Maps locations via `core.locations.droptop_operation_id`
- Reads/writes `inventory.count_snapshots`, `inventory.pull_log`
- Logs sync results to `inventory.droptop_sync_log` (mirrors the Monday.com `location_sync_log` pattern)

---

## Data safety rules

- **Never silently delete production data** — prefer soft deactivation (`deleted_at`, `active = false`)
- **Preserve source payloads** when importing external data (`raw_monday_data`, etc.)
- **Preserve audit fields** — `updated_by`, `last_change_source`, `updated_at`
- **Log sync summaries and errors** to the appropriate sync log table
- **Generated orders must be reviewable** before final submission unless the user explicitly approves auto-submission
- **Make exceptions visible** — missing data, unavailable tank readings, keep-fill items — never silently swallow them

---

## Common code patterns

```ts
// Schema access
const sb = supabase as any
sb.schema('outlier').from('report_entries').select('*')

// Auth store
const { profile, setProfile } = useAuthStore()

// Toast
import toast from 'react-hot-toast'
toast.success('Saved')
toast.error('Failed to save')

// Table hook — always pass pre-filtered data
const { table, globalFilter, setGlobalFilter } = useTable(filteredData, columns)

// Role check
import { isAdminOrDeveloper } from '@/lib/roles'
isAdminOrDeveloper(profile?.role)

// Dark mode
const { dark } = useDarkMode()
```

---

## Final response format

Every response that makes code or DB changes must end with this block:

```
Files inspected:
- src/...

Files changed:
- src/...

What changed:
- ...

Database changes:
- None  (or: migration required — paste SQL)

Testing steps:
1. ...
2. ...

Risks / assumptions:
- ...
```

---

## Things not to do

- Do not scan the whole repo by default
- Do not rewrite or restructure modules not directly related to the task
- Do not add new design colors or hex values
- Do not use `supabase.from()` (without `.schema()`) for any app table
- Do not use `.schema('public').from()` — sends an unsupported header to PostgREST
- Do not assume `platform.user_profiles.work_email` exists (column is `email`)
- Do not assume `platform.user_profiles.is_active` exists (use `deleted_at IS NULL`)
- Do not assume `tasks` is in `inventory` — it's in `core` (standalone tasks). `project_tasks` is still in `inventory`.
- Do not assume `issues` is in `inventory` — it's in `platform` (issue config tables `issue_statuses`/`issue_categories`/`issue_tracker_columns`/`issue_custom_values` stayed in `inventory`)
- Do not treat columns from pending (non-Uploaded) migration files as guaranteed in production — and don't treat root-migration-file location alone as proof a column is *missing* either; verify or use the decoupled save pattern
- Do not mix keep-fill products into standard order generation without special handling
- Do not hard-code Monday.com API tokens, Azure tenant/client IDs, OneDrive paths, or Supabase service-role keys — always use environment variables
- Do not introduce a new state management library (Zustand is already in use) without approval
- Do not add new `package.json` dependencies without explicit user confirmation
