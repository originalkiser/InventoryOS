# InventoryOS — Claude Code Handoff

**Project:** InventoryOS  
**Repo:** https://github.com/originalkiser/InventoryOS  
**Branch:** `main`  
**Supabase project:** `fbrguyigmqrzsowfusoi` (fbrguyigmqrzsowfusoi.supabase.co)  
**User:** mkiser97@gmail.com  
**Stack:** React + TypeScript + Vite + TailwindCSS + Supabase (multi-schema)

---

## Brand System

All UI uses the **Strickland Brothers** palette — tokens live in `tailwind.config.ts`.

| Token | Hex | Use |
|-------|-----|-----|
| `navy` | #002745 | Primary bg, nav, table headers |
| `inky` | #4F7489 | Secondary, inactive text, buttons |
| `sky` | #B7E0DE | Highlight, hover, focus ring, active accent |
| `cream` | #F2F1E6 | Page bg, card surfaces |
| `onyx` | #000000 | Use sparingly |

**Allowed off-palette exceptions only:**
- `#C0392B` — danger/critical red
- `#2ECC71` — inventory flag green
- `#E67E22` — inventory flag orange

**Fonts:** `font-heading` = Chakra Petch, `font-body` = DM Mono. Files in `src/assets/fonts/`.

**Rule:** Never add new hex values. Always use Tailwind tokens.

---

## Supabase Architecture

The app uses **multiple Postgres schemas** accessed via `(supabase as any).schema('x')`. Never use the default `supabase.from()` for cross-schema tables.

| Schema | Contains |
|--------|----------|
| `inventory` | Locations, counts, thresholds, orders, meeting_notes, projects, tasks |
| `core` | user_sidebar_prefs, shared config |
| `platform` | user_profiles (auth users) |
| `outlier` | Outlier report system (reports, report_entries, weeks, departments) |

### `platform.user_profiles` — critical gotchas
- Column is `email` (NOT `work_email`)
- Soft-delete via `deleted_at` — filter active users with `.is('deleted_at', null)` (NOT `.eq('is_active', true)`)
- `user_profiles.id` IS `auth.uid()` — no separate `user_id` join needed

---

## Pending Migrations (NOT yet applied to production)

These migration files exist locally but may not be in the production DB. The code is written defensively to handle their absence, but features won't fully work until they're applied.

### Apply via Supabase SQL editor:

**1. `20260625002000` — Outlier report_entries missing cols**
```sql
ALTER TABLE outlier.report_entries
  ADD COLUMN IF NOT EXISTS am_comment            text,
  ADD COLUMN IF NOT EXISTS am_comment_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS am_comment_updated_by uuid,
  ADD COLUMN IF NOT EXISTS location_id           uuid,
  ADD COLUMN IF NOT EXISTS area_manager_name     text,
  ADD COLUMN IF NOT EXISTS rdo_name              text;
```

**2. `20260625003000` — AM/RDO user assignment**
```sql
ALTER TABLE outlier.report_entries
  ADD COLUMN IF NOT EXISTS am_assigned_user_id  uuid,
  ADD COLUMN IF NOT EXISTS rdo_assigned_user_id uuid;
```
*(Enables "Assigned to Me" section in AM Dashboard)*

**3. `20260623130003` — Meeting notes links**
```sql
ALTER TABLE inventory.meeting_notes
  ADD COLUMN IF NOT EXISTS links jsonb DEFAULT '[]';
```
*(Enables link saving in meeting notes)*

---

## Decoupled Save Pattern

Wherever a new DB column might not exist in production, saves are split:

```typescript
// 1. Core save — always fires, shows error toast on failure
const { error } = await sb.schema('x').from('table')
  .update({ core_column: value, updated_at: new Date().toISOString() })
  .eq('id', id)
if (error) { toast.error('...'); return }

// 2. Best-effort save — fire-and-forget, silent on failure
sb.schema('x').from('table')
  .update({ new_column: value })
  .eq('id', id)
  .then(() => {})
```

This pattern is used in:
- `ReportViewPage.tsx` — `handleCommentChange`, `handleAMNameChange`, `handleRDONameChange`
- `AMDashboard.tsx` — `saveComment`
- `MeetingNotesPage.tsx` — `onSave` (links)

---

## Outlier Reporting Module

**Path:** `src/modules/operations/outlier/`

### Key files
| File | Purpose |
|------|---------|
| `pages/ReportViewPage.tsx` | Full report table — paste data, comment, AM/RDO assignment |
| `components/tables/ReportTable.tsx` | Table renderer with `AMUserInput` component |
| `components/dashboards/AMDashboard.tsx` | Area Manager view — assigned items, comment/complete |
| `components/dashboards/LeadershipDashboard.tsx` | Leadership overview |
| `types.ts` | `Report`, `ReportEntry`, `Week`, `UserProfile`, `AMLocation` |

### AM/RDO user picker (`AMUserInput` in ReportTable.tsx)
Every AM and RDO cell renders a text input + optional person-icon dropdown. When `appUsers` is passed as a prop, a picker shows all platform users. Selecting a user:
1. Fills the text field with `user.full_name`
2. Saves `area_manager_name` / `rdo_name` (core columns — always succeeds)
3. Best-effort saves `am_assigned_user_id` / `rdo_assigned_user_id` (new columns)

Users assigned via the picker appear in **"Assigned to Me"** section of their AM Dashboard.

### `appUsers` query pattern (ReportViewPage.tsx)
```typescript
(sb as any).schema('platform').from('user_profiles')
  .select('id, full_name, email')
  .eq('company_id', profile.company_id)
  .is('deleted_at', null)
  .order('full_name')
```

---

## Locations Module

**Quick access page:** `src/modules/locations/LocationsPage.tsx`  
**Config tab:** `src/modules/config/tabs/LocationsTab.tsx`  
**Lookup overlay:** `src/modules/locations/LocationLookupOverlay.tsx`

### Contextual filter dropdowns
Both LocationsPage and LocationsTab have cascading filter dropdowns:
```typescript
const LOC_FILTER_HIERARCHY = [
  { field: 'meta:owner', label: 'Owner' },
  { field: 'region', label: 'Region' },
  { field: 'meta:market', label: 'Market' },
  { field: 'meta:area_manager', label: 'Area Manager' },
  { field: 'meta:regional_director', label: 'Regional Director' },
]
```

`rowsAbove(fi)` computes rows passing all filters above index `fi` for accurate option counts. Filters are applied to raw data **before** `useTable()` so all TanStack features work on the filtered subset.

**localStorage keys:**
- `locations.page.dropFilters` / `locations.page.hiddenDropdowns`
- `locations.tab.dropFilters` / `locations.tab.hiddenDropdowns`
- `lookup.block.{block.id}.state` (sort, dropFilters, pageSize, page)

### `locFieldValue(loc, field)` helper
Reads base fields directly or `meta:X` fields from `loc.metadata[X]`. LocationsPage variant also handles `meta:regional_director` falling back to `meta:director`.

---

## Forms / LocationSeeder

**Path:** `src/modules/forms/FormBuilderPage.tsx`

`LocationSeeder` component lets users multi-select location groups (Owner, Region+director, Market+AM, Type) via checkboxes and seed them into a form field. Supports undo of last seed. Groups are built from location metadata via `useMemo`.

---

## AM Dashboard Header

`src/modules/operations/outlier/components/dashboards/AMDashboard.tsx`

Header subtitle shows:
- **"N assigned items"** — count of non-total `report_entries` for this AM's locations
- **"· N needs attention"** (orange) — entries without a comment and not complete

The large **UNCOMMENTED** counter on the right shows the same needs-attention count.

---

## Meeting Notes

**Path:** `src/modules/meetings/MeetingNotesPage.tsx`

Meetings save core fields first; `links` (array of `{ label, url }`) saves as best-effort afterward. If the `links` column doesn't exist yet, meetings still create/save — only links are silently dropped until the migration is applied.

---

## Common Patterns

### Schema access
```typescript
const sb = supabase as any
sb.schema('outlier').from('report_entries').select('*')...
```

### Toast
```typescript
import toast from 'react-hot-toast'
toast.success('...')
toast.error('...')
```

### Table hook
```typescript
const { table, globalFilter, setGlobalFilter } = useTable(filteredData, columns)
```
Always pass **pre-filtered data** to `useTable` when using dropdown filters.

### Role check
```typescript
import { isAdminOrDeveloper } from '@/lib/roles'
isAdminOrDeveloper(profile?.role)
```

---

## Recent Commits (latest first)

```
e9dc407 Fix meeting save failing due to missing links column
cf1afeb Fix comment save failures and update AM dashboard header
9949bf8 Fix AM/RDO name save: decouple name update from assignment column
83d31cb Fix appUsers query: filter by deleted_at IS NULL not is_active
16e5498 Fix outlier AM/RDO cell: combined text input + user picker in every row
a25fb2b Add contextual filter dropdowns to quick access Locations page
6a66cc1 Add Owner column, contextual dropdowns, location lookup persistence, form seeder upgrade, outlier AM/RDO user assignment
```
