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
├── TABLE_TEMPLATES.md             # the 5 table templates — consult before building any new table
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
    ├── lib/                       # supabase.ts, roles.ts, orderEngine.ts, recountEngine.ts, transforms.ts,
    │                              #   imagesToPdf.ts (dependency-free JPEG-only PDF writer), etc.
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
    │   ├── marketing/             # MarketingPlannerPage, modals/, tabs/ (campaign planning);
    │   │                          #   menuboard/ (Menu Board — MenuBoardPage, PublicMenuBoardPage,
    │   │                          #   MenuBoardPdfPage, useMenuBoard)
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
| `marketing` | campaign planning: campaign_templates, campaign_template_tasks, monthly_plans, campaign_assignments, campaign_tasks; Menu Board: menu_board_packages, menu_board_quart_defaults, menu_board_quart_overrides, menu_board_shares |
| `archive` | `deleted_rows` — every deleted row (as jsonb) from tables whose ids other records reference. Written only by an `AFTER DELETE` trigger; see below. |

**Deleted-row archive (`archive.deleted_rows`, migration `20260819_archive_deleted_rows.sql`):**
Cross-table references in this app are plain `uuid` columns with **no foreign keys**, so deleting a row (or clearing + re-uploading a table, which is a delete plus brand-new ids) silently orphans everything pointing at it — no error, it just stops matching. An `AFTER DELETE` trigger copies the full pre-delete row into `archive.deleted_rows` for the tables that carry that risk (`core.locations`, `core.pos_location_map`, `inventory.vendors`/`vendor_parts`/`issue_statuses`/`issue_categories`, `platform.departments`). Restore recipes are in the migration file's trailing comment — including the important case where rows were re-created under new ids, where the archive is used as an old-id → business-key map to repoint orphans rather than to re-insert. **When adding a table that other records will reference by id, add it to that trigger list.**

**Gotchas from recent schema moves — don't assume the old location:**
- `tasks` (standalone tasks) is in **`core`**, not `inventory`. `project_tasks` (project-scoped) is still in `inventory`.
- `issues` is in **`platform`**, not `inventory`. The issue *config* tables (`issue_statuses`, `issue_categories`, `issue_tracker_columns`, `issue_custom_values`) stayed in `inventory`.
- `exception_reports`/`location_comms` are separate but linked tables in `inventory` — a Location Comms row with `comm_type = 'Exception Reporting'` writes an `exception_reports` row too and stores its id in `exception_report_id`.
- `vendors` and `vendor_parts` moved from `core` to **`inventory`** (migration `20260818d_move_vendors_to_inventory.sql`) to match everything else they relate to (`global_products`, `uom_mappings`, `location_order_config`, `product_usage`). Before this move, a `.schema('inventory').from('vendor_parts')` query returned zero rows with no error rather than failing loudly, which let a real feature (Product Usage's vendor-part-number import) stay silently broken until caught manually — if you ever see a cross-schema table query return an empty result where you expected data, verify the schema against the file that actually owns/CRUDs that table before trusting this doc.
- `uom_mappings` moved from `core` to **`inventory`** (migration `20260821_orders_v2_uom_cost.sql`) — the *same* bug as the `vendor_parts` move above, on a different table: it was created in the original pre-schema-split `core` batch and never actually moved when `vendors`/`vendor_parts` did, despite the 20260818d migration's own comment claiming it was already in `inventory`. Nobody had verified it because the table was always empty, so the silent-zero-rows failure never surfaced. If a table's real schema location matters and it's unverified, query `information_schema.tables` rather than trusting this doc or a prior migration's comment.
- `global_products` moved from `core` to **`inventory`** (migration `20260824_move_global_products_to_inventory.sql`) — the *third* instance of this exact bug. The 20260818d migration's comment (quoted in the entry above) even lists `global_products` as one of the tables already correctly in `inventory` that `vendors`/`vendor_parts` needed to match — that claim was never true either. Every app reference (`GlobalProductsTab.tsx`, `NewOrderTab.tsx`, `useOrdersV2.ts`'s on-hand-unit conversion) already queried `inventory.global_products` and got silent empty results for it. Given this has now happened three times from the same original `core` batch, treat any *other* table this doc or a migration comment claims moved out of that batch as unverified until checked against `information_schema.tables`.

**RLS self-reference gotcha (hit `2026-09-10`, fixed by migration `20260922c`):** a policy's `USING`/`WITH CHECK` must never sub-`SELECT` the same table the policy is attached to — e.g. `(SELECT role FROM platform.user_profiles WHERE id = auth.uid())` inside a policy ON `platform.user_profiles`. Postgres 17 raises `42P17 infinite recursion detected in policy` the instant that branch actually executes. This can sit unnoticed for a long time: a row matching `id = auth.uid()` (editing your own row) short-circuits before that branch ever runs, so it only fires once someone acts on a *different* row — in this case it silently broke the entire admin "edit another user" flow from the `20260903e` RLS-initplan refactor onward. Use the existing `is_admin()` / `get_my_company_id()` `SECURITY DEFINER` helper functions instead, which read `user_profiles` without going back through its own RLS. If you're writing or auditing any policy and see an inline `SELECT ... FROM <the same table the policy is on>`, replace it with one of those helpers.

---

## Roles & department access

Roles (`src/lib/roles.ts`): `developer`, `administrator`, `area_manager`, `director`, `department_user` (legacy `admin`/`user` still handled for display).

- `isAdminOrDeveloper(role)` — developer/administrator/admin only.
- `department_user` role is scoped to specific departments via `platform.departments` + `platform.user_department_memberships`. `useDeptAccess()` (`src/hooks/useDeptAccess.ts`) returns the set of allowed sidebar section slugs for the current user, or `null` if unrestricted. A department's `slug` **is** the sidebar section key it gates — as of `2026-09-10` that's every top-level `Sidebar.tsx` section except the admin-only `global-config` (`inventory`, `droptop`, `data-connections`, `operations`, `marketing`, `finance`, `accounting`), plus a standalone `project_management` department that isn't its own sidebar section. `App.tsx`'s `SmartRedirect`/`DEPT_FIRST_ROUTE` sends department users to their first allowed section.
- The assignable list in the admin UI is **derived, not hardcoded**: `Sidebar.tsx` exports `ASSIGNABLE_SECTIONS` (built from `SECTION_ITEMS`), and `UsersPage.tsx`'s Manage User modal builds its "Section Access" checkboxes from that list — so a newly-added top-level sidebar section shows up there automatically. The first time an admin actually checks a section for someone, the save handler creates that section's `platform.departments` row on the fly (if it doesn't exist yet) before syncing the membership — no migration needed for sections added after `2026-09-10`.
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
- **Building a new table? Read `TABLE_TEMPLATES.md` first** — it defines the 5 table shapes this app standardizes on (Data Table / Inline-Editable Data Table / Read Table + Edit Modal / Import-Paste Preview / Matrix-Pinned-Column Grid) and which one a given behavior maps to. Existing tables are mid-migration onto these; a new table should be built as one of the 5 from the start, not as a 6th one-off `<table>`.
- Operational tables should be **dense and readable** — avoid excessive padding
- Always include loading and error states in data-fetching components
- Toast notifications: `import toast from 'react-hot-toast'` → `toast.success()` / `toast.error()`

---

## Database schema reference

### `core.locations`
`id, company_id, name, region, active, metadata (jsonb), order_date, district, monday_item_id (nullable, unique), raw_monday_data, last_synced_at, created_at, updated_at, updated_by, last_change_source`

- No `location_code` column — confirmed absent in production (`column "location_code" does not exist`) despite this doc previously listing one. `name` holds the short shop identifier (e.g. `"1521"`), not a combined label like "1521-Port Arthur" — that display label is constructed elsewhere. The rest of this column list is unverified beyond `id`/`name`/`active`/`created_at`/`updated_at`; spot-check via `information_schema.columns` before relying on any other field here.

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
`departments`: `id, company_id, name, slug, sort_order, created_at, created_by` — originally seeded with `inventory`, `operations`, `marketing`, `finance`, `accounting`, `project_management` per company; `droptop` and `data-connections` were added `2026-09-10` (migration `20260922b_departments_sidebar_sections.sql`) once section access became sidebar-driven — see Roles & department access above. Any section added after that gets its row created on demand (client-side, on first grant) rather than via migration. `user_department_memberships`: `id, user_id, department_id, company_id, created_at, created_by`. Drive `department_user` role scoping.

### `platform.issues`
Moved from `inventory.issues`; adds `department_id` (references `platform.departments`). `inventory.issue_statuses`, `inventory.issue_categories`, `inventory.issue_tracker_columns`, `inventory.issue_custom_values` remain in `inventory` and still join by issue id.

### `marketing.*` (campaign planning)
`campaign_templates` (company_id, name, category, description, is_active, sort_order) → `campaign_template_tasks` (per-template checklist) → `monthly_plans` (company_id, location_id, plan_month, plan_year, unique per location/month/year) → `campaign_assignments` (plan + template, snapshots name/category at assignment time) → `campaign_tasks` (assignment + template task, snapshots name/description, status: not_started/in_progress/complete/blocked/not_applicable). Assignments/tasks **snapshot** the template text at creation time so later template edits don't retroactively change existing plans.

### `marketing.menu_board_packages` / `menu_board_quart_defaults` / `menu_board_quart_overrides` / `menu_board_shares`
Menu Board module (see Module notes below). `menu_board_packages`: package_key, display_name, qualifier, price_column (the `core.locations` numeric column this package is priced from), sort_order, active, price_pos_x/y, price_font_size, quart_pos_x/y, quart_font_size (board-layout fields, all `%` of the board image, draggable via the Board tab's "Edit layout" toggle). `menu_board_quart_defaults`: company-wide package_key → price_per_quart/included_quarts. `menu_board_quart_overrides` (migrations `20260924_menu_board_quart_override_simplify.sql` + `20260925_menu_board_quart_override_per_package.sql`): one row per **shop**, not per (shop, package) — `location_id`, `prices` (jsonb, package_key → price_per_quart; a package_key absent just uses that package's company default), `notes`; unique on `(company_id, location_id)`. Included quarts is never shop-customizable, it always comes from `menu_board_quart_defaults` for whichever package is being priced. `menu_board_shares` (migrations `20260921_menu_board_shares.sql` + `20260922_menu_board_share_slug.sql` + `20260923_menu_board_share_hide_page2.sql`): token (PK, uuid), company_id, location_id (nullable — null = viewer picks a shop), label, slug (nullable, company-unique, `<shop number>-<4-char hash>` shape), hide_page2 (boolean, default false — omits the page-2 staff reference sheet from the public board/PDF/layout controls for this link), active, created_by, created_at — backs the public no-auth share-link system (routes on the `menu.sboc.app` subdomain — see Deployment below — `/:slug`, `/:slug/pdf`, legacy `/m/:token`) via SECURITY DEFINER RPCs `get_menu_board_share[_by_slug]` / `get_menu_board_shop[_by_slug]` (the latter returns the shop's custom prices as a `custom_prices` jsonb object, package_key → price).

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

### Menu Board — `src/modules/marketing/menuboard/`

An on-screen (and printable/shareable) recreation of the printed lobby/bay pricing board, priced live per shop straight from `core.locations`' existing price columns (`economy`, `premium_hm`, `premium_full_synthetic`, `premium_full_synthetic_hm`, `rp`) — no separate price-entry system. Route `/menu-board` (Marketing sidebar section); tabs: Board / Package Mapping / Quart Pricing / Custom Pricing / Shop Links.

- **`MenuBoardPage.tsx`** — `Board` (the board itself: page-1 art `src/assets/MenuBoard-01.png` with live price/quart text absolutely positioned by DB `%`, plus page-2 `MenuBoard-02.png` staff reference sheet) and `BoardViewer` (zoom + Single/Stacked/Side-by-side layout toggle + Download PDF button) are both exported and reused by the public share page — one implementation, two entry points. `PriceComposite` renders the printed-board price treatment (small `$`, big dollars, cents whose top aligns with the dollars' top, "PLUS TAX" tucked underneath).
- **PDF export does not screenshot the DOM.** html2canvas couldn't reproduce the price composite's layout (dropped the overlay `transform`, mangled the superscript stack — every price came out misaligned), so `buildMenuBoardPdf` (exported) draws the board straight onto a `<canvas>` — the art image plus `fillText` for every price/quart line via its own `drawPriceComposite` — then `src/lib/imagesToPdf.ts` (a tiny dependency-free JPEG-only PDF writer; `fit: 'image'` mode sizes each page to the image's own shape with no white margin) turns that into a real 2-page `.pdf`. `PriceComposite` (DOM) and `drawPriceComposite` (canvas) render the same thing two different ways and have to be kept visually in sync by hand — there's no shared renderer between them.
- **Public share links live on their own subdomain, `menu.sboc.app`** (migrated off `sboc.app/menu-board/...` `2026-09-12`) — see `App.tsx`'s `isMenuBoardHost()`/`MenuBoardApp`, a hostname check (not a route) that renders a completely separate, minimal router with nothing else in it, since a bare `/:slug` path registered on the main app domain would collide with every real app route. `MENU_BOARD_BASE_URL` in `MenuBoardPage.tsx` is hardcoded to `https://menu.sboc.app/` (not derived from `window.location.origin`) precisely so link generation is correct regardless of where the admin UI itself happens to be loaded from. `ShareMenuBoardModal` mints a `marketing.menu_board_shares` row, either locked to one shop (`location_id` set — board-only, no picker) or open (viewer picks from a dropdown). A locked share gets a pretty `slug` (`makeLockedShareSlug()`, `<shop number>-<4-char hash>`) so its URL reads `menu.sboc.app/4-a3f9`; `menu.sboc.app/m/:token` still works for links minted before slugs existed. `PublicMenuBoardPage.tsx` renders the board with zero SB Net chrome for either URL shape. `MenuBoardPdfPage.tsx` (route `menu.sboc.app/:slug/pdf`, slug-only — locked shares only) rebuilds and auto-downloads that shop's PDF fresh on every visit; nothing is ever a cached file, so an OSL price change shows up immediately through both the board link and the PDF link. **`NearestMenuBoardPage.tsx`** (route `menu.sboc.app/` — the bare root) resolves a visitor with no specific share link to the nearest shop via browser geolocation, computing plain Haversine distance client-side against every active shop's coordinates from the `get_menu_board_shop_list()` RPC; falls back to a manual shop-search picker (same data, no separate RPC needed) if geolocation is denied/unavailable/unpopulated.
- **`ShopLinksTab`** ("Shop Links" tab) bulk-ensures every active shop has its own locked share (chunked insert with a same-chunk slug-collision retry), and **self-heals** any older share that predates slug support by backfilling one onto it — that's the fix for a shop whose board link works but whose PDF link is missing (the PDF route only understands slugs). Built on the standard `useTable`/`DataTable` combo, so every column (incl. Owner via the existing `ownerBucket()` helper, Regional Director, Market, Area Manager) gets sort + an Excel-style multi-select filter and the whole table gets CSV/XLSX export for free via `DataTable`'s `exportFilename` prop — no bespoke filter/export code needed.
- All board layout numbers (`price_pos_x/y`, `price_font_size`, etc.) are tied to the *current* art's exact pixel layout (`MenuBoard-01.png`/`-02.png`, 2850×4950) — re-measure (or drag-adjust via "Edit layout") if that art is ever re-exported.

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
- The Droptop `sig`/`x-api-key` request-signing logic (`DROPTOP_PUBLIC_KEY`/`DROPTOP_PRIVATE_KEY` Supabase secrets) is **copy-pasted identically** into every `supabase/functions/droptop-sync-*` Edge Function rather than shared — there's no common helper module. Copy it from `droptop-sync-orders`/`droptop-sync-staff-time-clock`, never from `droptop-proxy` (dead code, unused, a different non-matching signing scheme).
- `inventory.droptop_time_records` (migration `20260928_droptop_staff_time_clock.sql`, synced by `droptop-sync-staff-time-clock`): clock-in/clock-out records per location, for comparing staffing against car counts (`inventory.droptop_orders`) and order timing. One row per (company_id, location_id, droptop_user_id, clock_in) — Droptop's `get-staff-time-clock` response has no record id of its own, so that's the natural key.
- **Droptop — Staff Time Clock is a full scheduled/manual data connection** (migration `20260929_droptop_time_clock_data_connection.sql`), same shape as Droptop — Orders: `droptop-sync-staff-time-clock` supports `mode: 'sync'` (explicit range or `daysBack`, manual backfill) and `mode: 'incremental'` (each location pulls forward from its own `inventory.droptop_time_clock_sync_state.last_synced_date` through yesterday, capped by `MAX_CATCHUP_DAYS`/`MAX_SINGLE_PULL_DAYS` — copy-pasted from `droptop-sync-orders`' incremental logic, not shared). The dispatcher's `runDroptopTimeClock` mirrors `runDroptopOrders` exactly: filters to not-yet-caught-up locations, most-overdue-first, batches `MAX_LOCATIONS_PER_TICK` per tick via `runChunksConcurrently` — scheduled runs always batch across every eligible location regardless of what a manual backfill was last scoped to. `DataConnectionsTab.tsx`'s main-grid card's Run Now calls `mode: 'incremental'` directly (no service wrapper, same as `automated_checks`/`heatmap_rollup_refresh`); its own "Historical Staff Time Clock Backfill" card is `mode: 'sync'` with an explicit date range **and** Region/Market/Shop multi-select filters (see below) — for reaching further back or re-pulling a specific scope, not routine catch-up.
- **Droptop webhooks** (`supabase/functions/droptop-webhook-b7a51c94196e610b/`) — real-time-ish push for `orders.finalized`/`orders.voided`/`orders.started`/`users.clocked_out`, additive to (not a replacement for) the existing batch/incremental syncs, which keep running as a reconciliation safety net for anything a missed webhook delivery didn't cover. **Auth is real HMAC-SHA256 verification** (`X-droptop-signature` / `X-droptop-timestamp` headers, secret in `DROPTOP_WEBHOOK_SECRET` — get the value from Droptop's own webhook settings, not visible on the plain "Add Endpoint" screen) — a request with a missing/invalid signature is rejected (403) before any DB work, and the function fails closed (500) if the secret isn't configured at all. The signed message is `${timestamp}.${JSON.stringify(rawBodyText)}` — note that's `JSON.stringify` of the raw body **text** (a string), not of the parsed object; re-serializing a parsed object produces different bytes and the signature will never match. The function's own random 16-hex-char name suffix is now just a secondary, redundant layer, not the real security boundary. Deliveries are logged to `inventory.droptop_webhook_log` (migration `20260930b_droptop_webhook_log.sql`) keyed by Droptop's own delivery id — doubles as an idempotency guard (a delivery already logged `'success'` is deduped) and carries the raw payload (`raw_payload` jsonb), since the exact shape of a populated `data` field was built from Droptop's docs/examples, **not yet confirmed against a real live delivery** — check that column first if anything looks wrong. `orders.*` events write the identical row shape `droptop-sync-orders` writes (same `inventory.droptop_orders` + 8 child tables), guarded against out-of-order retry delivery via `order_last_updated`. `users.clocked_out`'s own payload is deliberately sparse (no hours/wage/name) — the handler calls back into `get-staff-time-clock` for a tight window around that one punch to get the enriched fields, rather than trying to construct a row from what the webhook alone provides.
- **`inventory.droptop_order_month_rollup`** (migration `20260930c_droptop_order_month_rollup.sql`) — pre-computed Orders/Shops-with-orders counts per tracked month for the Historical Backfill Plan checklist (Data Connections). Read-only on page load (a plain SELECT over ~15-20 rows, can never time out); recomputed only via the "Refresh Stats" button (`refreshMonthStats` in `DataConnectionsTab.tsx`), which calls the existing `get_droptop_order_month_stats(p_start, p_end)` RPC **once per month** (a single-month range each) rather than once for the whole multi-month range — the RPC itself is unchanged, but a single-month scan stays index-friendly regardless of how large `droptop_orders` grows, which is what actually fixes the cost (confirmed via `EXPLAIN ANALYZE`: even one month is genuinely expensive at current volume — ~200k orders/month, `count(DISTINCT location_id)` needs a real disk-spilling sort — so this is deliberately a slow-but-tolerable **manual** action with its own loading state, not something to ever call automatically on page load again). Written directly by the calling user's own session (not a service-role job) — this is a lightweight on-demand cache for one config-page checklist, not sensitive data.
- **Region/Market/Shop-scoped manual backfills** (`DataConnectionsTab.tsx`): the Historical Usage/Orders/Staff-Time-Clock Backfill cards all resolve their target location ids through one shared `resolveBackfillLocationIds(regions, markets, shops)` — each filter is optional and AND-narrows together (empty = no restriction from that level), and **at least one** must be set or the Run Backfill button stays disabled. This exists specifically so a large pull (Droptop Orders' real production history: chunk-timeout/rate-limit issues at full-company scale) can be scoped to just the region/market/shop(s) that actually need it instead of defaulting to every shop — the old "must explicitly pick shops one at a time or nothing runs" gate still applies, just with two more ways to reach a shop list besides typing shop numbers individually.
- **Staffing Report** (`src/modules/customers/StaffingReportPage.tsx`, route `/staffing-report`, Droptop sidebar section) reads `inventory.droptop_time_records` + `inventory.droptop_orders` directly (no dedicated rollup table) and joins them client-side by (location_id, date). Three tabs in this order — **Summary, Rollup, Labor Config** — one shared Region/Market/AM/Shop + period filter bar above them (same filter shape as Droptop Orders, minus its order-specific Package/Product ID/Vehicle/Fleet dropdowns):
  - **Summary** (default/first tab) — company-wide (or filtered) KPIs: orders, labor $, labor % of revenue, LHCE, and a "By Day of Week" card whose 7 mini-cards each stack 3 metrics (total hours + avg/day when more than one of that weekday falls in the period, labor % of revenue, LHCE — all computed per weekday, not just hours). Below that, a full `RollupTable` (paginated, exportable) so shop-level detail doesn't require switching tabs. **"Effective car" = Finalized orders only** (excludes Void/Uncollectible) — matches how Droptop Orders/Customer Heatmap already treat revenue; this is also why the Rollup's own Orders column counts Finalized only, not every order regardless of status.
  - **Rollup** — the same `RollupTable` component as Summary's (each mounted instance keeps independent expand/page state): a 3-level drill-down for the selected period (shop -> day -> employee timecard), hand-rolled rather than `DataTable`/`useTable` since that shape doesn't fit any of the 5 templates in `TABLE_TEMPLATES.md` (not a flat list, not a matrix) — same precedent as Templates 4/5 for shapes without a shared component yet. Paginated (25/50/100/All, default 25) and exportable — the export is a flat CSV with a `Level` column (Shop/Day/Employee) covering the whole on-screen hierarchy, not just the top-level shop rows.
  - **LHCE** ("Labor Hours / (Effective) Car" — hover the ⓘ next to the label for the spelled-out tooltip) = hours ÷ orders. Catch during the 2026-09-30 rename: the Rollup table's column used to be labeled "Orders / Labor Hour" but computed orders ÷ hours (the reciprocal) — fixed to the correct hours ÷ orders formula as part of renaming it, not just relabeled.
  - **Labor Config** (renamed from "Labor Hour Forecast") — hosts the Manager Wage Threshold setting and the Labor Hour Forecast upload (per-(shop, date), `inventory.labor_hour_forecast`, migration `20260930_labor_hour_forecast.sql`; upload matches header names loosely via regex, not an exact-name mapper), comparing actual vs. forecast hours as a percent, split hourly-employee vs shop-manager on both sides. **A "Staffing List" upload (real employee -> Manager/Hourly roster, to replace the wage-threshold proxy below for anyone on it) is planned for this same tab but not built yet** — flagged in the file's own header comment, not stubbed in the UI.
  - **The hourly-vs-manager split is a wage-threshold PROXY, not real data** — confirmed by scanning every distinct key ever present across `droptop_time_records.raw`'s payload: there is no role/title/employee-type field anywhere in what Droptop's time clock API returns, on the user OR the time-record object. The threshold ($/hr and above = manager) is a company-wide setting (`useAppSetting`, key `staffing_manager_wage_threshold`, adjustable on the Labor Config tab) precisely because it's approximate — don't treat it as authoritative once the Staffing List roster above exists.
  - **Not yet built** (large enough to need their own pass): an Alerts tab (user-configured threshold rules by KPI — LHCE, Labor % of Revenue, Daily/Weekly Hours by Employee/Shop — with greater-than/less-than/between operators, per-shop or all-shop scope, a live violations table, and conditional formatting on the Rollup table) and the Staffing List roster upload mentioned above.
  - **Named-period labels show their resolved date range everywhere in the app**, not just here: `formatPeriodOptionLabel()`/`formatRangeLabel()` (`src/lib/datePeriods.ts`) turn "Last Week" into "Last Week (08/30-09/05/2026)" (4-digit year on both sides only if the range crosses a year boundary) — wired into the shared `PeriodPicker.tsx`, so Droptop Orders and Customer Heatmap picked this up automatically too, not just Staffing Report.

---

## Deployment

- **Live today: GitHub Pages**, via `.github/workflows/deploy.yml` (push to `main` → `npm run build` → `actions/upload-pages-artifact` → `actions/deploy-pages`), served at `originalkiser.github.io/InventoryOS/`. `vite.config.ts`'s `base` is `'/InventoryOS/'` when `GITHUB_ACTIONS` is set and `'/'` otherwise, so a Cloudflare or local build automatically gets the right base with no manual toggle. The workflow's `concurrency: {group: pages, cancel-in-progress: true}` means a deploy cancelled mid-flight by a fast-follow push can leave the Pages backend stuck ("due to in progress deployment") for up to ~90 min — it clears on its own, or can be cancelled manually in the Actions/Environments UI.
- Neither GitHub Pages nor Cloudflare Pages does server-side SPA routing, so a deep link (e.g. `/menu-board/4-a3f9`) needs the host to fall back to serving the app shell rather than a real 404. `vite.config.ts`'s `spa404Plugin` generates `dist/404.html` as an exact copy of the built `dist/index.html` on every build (`closeBundle` hook, alongside the existing `versionFilePlugin`) — no per-platform step required. **Do not reintroduce a hand-written `public/404.html`** — an earlier one used a GitHub-Pages-specific query-string encode/decode trick (`/InventoryOS/tasks` → `/InventoryOS/?/tasks`) that assumed the site always lived under a `/RepoName/` subpath; once the app moved to a root domain (`sboc.app`) that assumption broke catastrophically — each re-serve of `404.html` re-encoded the already-encoded query string, producing a runaway `?/&/~and~/~and~/~and~/...` URL that never resolved.
- **Live on Cloudflare Pages at `sboc.app`** (cut over `2026-09-12`; GitHub Pages at `originalkiser.github.io/InventoryOS/` still serves `main` in parallel until explicitly retired). The Cloudflare project was set up via the unified "Workers & Pages" dashboard, which is worth knowing about if you're ever troubleshooting it: that flow's "Create application" wizard creates a **Worker** by default (`wrangler deploy`), not a **Pages** project, no matter what deploy command you configure afterward — the actual Pages project has to be created separately via `wrangler pages project create <name> --production-branch=main`, and the CI's Deploy command must be `npx wrangler pages deploy dist --project-name=<name> --branch=main` (the explicit `--branch` matters: Cloudflare's build environment checks out a detached HEAD, so wrangler can't auto-detect the branch, and a deploy that doesn't match the configured production branch silently lands as a Preview deployment instead of Production — custom domains only ever serve Production). The API token used for the build also needs the **Cloudflare Pages: Edit** permission explicitly added — it's not implied by an account owner's Super Administrator role.
- Only 2 `VITE_*` env vars are actually read by the app: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `.env.example` also lists some legacy/unused OneDrive/Droptop vars that nothing currently reads.
- **In-app 404** (`src/pages/NotFound.tsx`) is what `appRoutes.tsx`'s catch-all route renders for an unmatched authenticated path — SB-branded (droplet mark + brand tokens), replacing what used to be a silent `<Navigate to="/dashboard" replace />`. This is unrelated to `dist/404.html` above (the static host-level SPA fallback) — that file still has to stay an exact `index.html` copy so a nonexistent physical path can load the app shell at all; `NotFoundPage` only ever renders once the app has already mounted and React Router itself found no matching route.
- **Apple/Android "Add to Home Screen" icons**: `public/apple-touch-icon.png` (180×180), `public/android-chrome-192x192.png`/`-512x512.png`, and `public/site.webmanifest` — all generated from `src/assets/SBOC-IconCream.png` (the droplet mark) composited onto a solid navy square. `index.html`'s `<link rel="apple-touch-icon">`/`<link rel="manifest">` use Vite's `%BASE_URL%` placeholder (not a plain absolute path) so they still resolve under GitHub Pages' `/InventoryOS/` subpath, not just the Cloudflare root domain — but `site.webmanifest`'s own internal icon paths are plain absolute paths (`/android-chrome-192x192.png`), since it's a static JSON file Vite doesn't template; those are only guaranteed correct on the live `sboc.app` root domain.
- **Public, no-auth routes** bypass `RequireAuth` entirely in `App.tsx` and must never expose anything beyond what their own SECURITY DEFINER RPC returns: `/f/:shareToken` (forms) on the main app domain; `/` (nearest-shop geolocation landing), `/:slug`, `/:slug/pdf`, legacy `/m/:token` (menu board share + PDF) on the separate `menu.sboc.app` subdomain, handled by its own tiny router (`MenuBoardApp`) rather than routes registered alongside the main app. React Router matches the most specific path regardless of declaration order, so `/f/:shareToken` coexists fine alongside the authenticated `/*` AppShell splat.

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

- **Do not reintroduce self-serve workspace/account creation.** A `/setup` self-serve signup page + a `completeSetup()` auto-heal path in `useAuth.ts` (any authenticated Supabase user with no profile row silently got a brand-new company created for them) were both removed for security — this app is Strickland Brothers-only, every real user is created by an admin via the `invite-user` Edge Function, which creates the auth user and the `platform.user_profiles` row together in one step. If `useAuth.ts`'s `loadProfile` ever encounters a session with no profile row (or a profile with no `company_id`), the correct behavior is to sign the user back out and show an error — never to auto-provision anything.
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
