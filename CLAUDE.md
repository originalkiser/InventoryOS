# InventoryOS — Claude Code Instructions

## Project overview

InventoryOS is an internal Strickland Brothers operating platform. It consolidates and replaces numerous third-party SaaS tools. Modules cover inventory counting, ordering, location management, outlier reporting, meeting notes, forms, project task tracking, EOD review workflows, scheduling, month-end processing, and integrations (Monday.com, OneDrive, Azure/Microsoft sign-in).

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
    │   ├── inventory/             # InventoryOverlay, InventoryView
    │   └── upload/                # FileUploadZone, ColumnMapper, DataSourceLinker
    ├── hooks/                     # useAuth, useTable, useDarkMode, useSidebarPrefs, useFeatureAccess, etc.
    ├── lib/                       # supabase.ts, roles.ts, orderEngine.ts, recountEngine.ts, transforms.ts, etc.
    ├── modules/
    │   ├── admin/                 # UsersPage, InviteUserModal
    │   ├── config/
    │   │   ├── GlobalConfigPage.tsx
    │   │   ├── ConfigPage.tsx
    │   │   └── tabs/              # LocationsTab, VendorPartsTab, OrderConfigTab, ProductMappingTab,
    │   │                          #   GlobalProductsTab, PosLocationMapTab, CompanyHolidaysTab
    │   ├── dev-hub/               # DevHubPage
    │   ├── feature-requests/
    │   ├── forms/                 # FormBuilderPage, FormsListPage, FormAssignmentsPage, FormResultsPage
    │   ├── issues/                # IssuesPage, IssueFormModal
    │   ├── locations/             # LocationsPage, LocationLookupOverlay, LocationDataSourceConfig
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
    ├── services/
    ├── stores/                    # authStore, monthEndStore, orderStore, weeklyStore (Zustand)
    ├── types/                     # database.ts, forms.ts, index.ts, integrations.ts
    └── utils/                     # monthEndUtils.ts, orderNumberUtils.ts
```

**Migration status:** Files under `supabase/migrations/Uploaded/` are applied to production. Files in `supabase/migrations/` root may be pending. Treat root-level migrations as possibly not yet live.

---

## Supabase architecture

The app uses **multiple Postgres schemas**. Never call `supabase.from()` for cross-schema tables — always use the cast pattern:

```ts
const sb = supabase as any
sb.schema('inventory').from('table_name')
sb.schema('core').from('table_name')
sb.schema('platform').from('table_name')
sb.schema('outlier').from('table_name')
```

### Schema map

| Schema | Contains |
|--------|----------|
| `inventory` | counts, thresholds, orders, meeting_notes, projects, project_tasks, monthly_ending_balances, tank_monitors, location_order_config, global_products, product_id_mappings, uom_mappings, vendor_parts, vendors, product_usage |
| `core` | **locations**, user_sidebar_prefs, shared config, pos_location_map, company_holidays |
| `platform` | user_profiles (auth users, company, role, preferences) |
| `outlier` | report system: reports, report_entries, weeks, departments |

---

## `platform.user_profiles` — critical rules

- **Email column is `email`**, not `work_email`
- **Active users:** filter with `.is('deleted_at', null)` — **never** `.eq('is_active', true)` (column does not exist)
- `user_profiles.id` IS the auth user ID — no separate join needed
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
- `LocationLookupOverlay.tsx` — floating lookup panel with dnd-kit column management
- `LocationDataSourceConfig.tsx` — Monday.com / Azure source config

Filter hierarchy: `meta:owner` → `region` → `meta:market` → `meta:area_manager` → `meta:regional_director`. Apply filters **before** passing data to `useTable()`.

`locFieldValue(loc, field)` reads base fields directly or `meta:X` from `loc.metadata[X]`. `meta:regional_director` falls back to `meta:director`.

Config tab: `src/modules/config/tabs/LocationsTab.tsx` (uses `useConfigTab` hook).

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
- Do not treat columns from pending (non-Uploaded) migration files as guaranteed in production
- Do not mix keep-fill products into standard order generation without special handling
- Do not hard-code Monday.com API tokens, Azure tenant/client IDs, OneDrive paths, or Supabase service-role keys — always use environment variables
- Do not introduce a new state management library (Zustand is already in use) without approval
- Do not add new `package.json` dependencies without explicit user confirmation
