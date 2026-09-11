# InventoryOS — Table Templates Reference

**Read this before building any new table.** As of 2026-09-11 this app has ~60 table
instances across ~56 files, and the large majority hand-roll their own `<table>` markup —
each with its own copy of `overflow-auto rounded border`, sticky-header classes, loading/empty
states, and (until 2026-09-11) its own copy of bugs already fixed elsewhere (a dropdown-menu
z-index bug existed only in the one *shared* table component and nowhere else, for example).

This doc defines **5 templates**. Every new table should be one of these five — pick by
behavior, not by copying whichever existing page looks closest. Existing tables are being
migrated onto these over the following weeks (not urgent, tracked separately) — this doc is
about what **new** tables should do starting now.

Companion piece: `CLAUDE.md`'s Brand and UI rules / Common code patterns sections cover the
non-table UI conventions (tokens, `Modal`, `Toggle`, toast, etc.) these templates build on.

---

## Decision guide

Ask these in order — the first "yes" is your template:

1. **Does the table exist mainly to collect a batch of new rows before one commit** (CSV/XLSX
   upload preview, paste-from-Excel, bulk import)? → **Template 4 — Import / Paste Preview**
2. **Is the data inherently two-dimensional** — a matrix (shop × package, product × month) that
   needs a frozen first column and/or frozen header while scrolling both axes, or user-orderable
   columns? → **Template 5 — Matrix / Pinned-Column Grid**
3. **Does editing a row mean opening a form for that one record** (more fields than fit in a
   cell, or the row's own display text needs to stay selectable/copyable)? → **Template 3 — Read
   Table + Edit Modal**
4. **Does editing happen directly in the cells** (a number, a dropdown, a toggle, typed/clicked
   right there, saved on blur/change)? → **Template 2 — Inline-Editable Data Table**
5. **Otherwise** — it's for browsing, sorting, filtering, exporting: → **Template 1 — Data
   Table**

If a table doesn't feel like it fits any of the five, it's very likely still Template 1 with a
column you haven't designed yet, or Template 3 with a modal you haven't built yet — resist
adding a sixth shape.

*(A few existing tables aren't real UI at all — an HTML string built only to put a formatted
table on the clipboard for pasting into Excel/Outlook, e.g. `orders-v2/shared.ts`'s
`copyTableToClipboard`, `locations/tankEmail.ts`. Those aren't part of this system — build them
as a plain string-building helper, not as a rendered table.)*

---

## Template 1 — Data Table

**Use for:** browsing, sorting, filtering, exporting a list. The default choice — most new
tables are this.

**Component:** the existing shared `DataTable` (`src/components/shared/DataTable.tsx`) +
`useTable` (`src/hooks/useTable.ts`). Don't hand-roll a `<table>` for this shape — every one of
the ~20 read-only hand-rolled tables in the app today is reinventing what this already does:
sorting, an Excel-style per-column multi-select filter (click the funnel icon in any header —
free on every column, no per-column wiring needed), a global search box, CSV/XLSX export,
column-visibility toggling, pagination, and optional row-select + bulk delete.

```tsx
import { createColumnHelper } from '@tanstack/react-table'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'

interface Row { id: string; name: string; email: string | null }
const col = createColumnHelper<Row>()
const columns = [
  col.accessor('name', { header: 'Name', cell: (i) => i.getValue() }),
  col.accessor('email', { header: 'Email', cell: (i) => i.getValue() || '—' }),
]

function MyTab() {
  const data = useMemo(() => /* pre-filtered rows */, [/* deps */])
  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, {
    persistKey: 'my-module:my-tab', // optional — remembers sort/filter in localStorage
  })
  return (
    <DataTable
      table={table}
      globalFilter={globalFilter}
      onGlobalFilterChange={setGlobalFilter}
      exportFilename="My Table"     // omit to hide the Export button entirely
      loading={loading}
    />
  )
}
```

**Real examples:** `src/modules/locations/LocationsPage.tsx`, almost every
`src/modules/config/tabs/*Tab.tsx`, `MenuBoardPage.tsx`'s `ShopLinksTab` (the newest one —
built 2026-09-10, a good current reference for adding columns + export together).

**Gotchas:**
- **Pass pre-filtered data into `useTable`**, not the raw dataset with filters applied
  after — dropdown/hierarchy filters (Owner → Region → Market → AM, location exclusions, etc.)
  go before `useTable()`, TanStack's own per-column filters happen inside it.
- `exportFilename` is what turns on the Export button — omit it if export doesn't make sense
  for this table (rare).
- `hideColumnControl` / `hideExport` suppress the built-in Columns/Export dropdowns when the
  page supplies its own.
- `mobileCards` renders each row as a stacked card below the `sm` breakpoint — opt in for
  operational tables people check on a phone.
- `onBulkDelete` + row selection is the safe pattern for "delete some rows" — it deletes only
  the checked ids, unlike a clear-and-reupload that orphans anything referencing the old rows.
- Any dropdown menu you add to the toolbar needs `z-30` or higher — the sticky `<thead>` is
  `z-20` and a same-or-lower z-index dropdown renders *behind* it (this exact bug shipped once
  already, fixed 2026-09-11).

---

## Template 2 — Inline-Editable Data Table

**Use for:** the same browse/sort/filter/export shape as Template 1, but some columns are
editable right in the cell — a number, a `<select>`, a `Toggle` — with no modal.

**Component:** still `DataTable` + `useTable` — this isn't a different component, it's a
convention for what a column's `cell` renders.

```tsx
col.accessor('price_font_size', {
  header: 'Price Font Size',
  cell: (i) => {
    const row = i.row.original
    return (
      <input
        type="number"
        defaultValue={i.getValue()}
        onBlur={(e) => {
          const v = Number(e.target.value) || i.getValue()
          if (v !== i.getValue()) updateRow(row.id, { price_font_size: v })
        }}
        className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right"
      />
    )
  },
}),
```

**Real examples:** `MenuBoardPage.tsx`'s `PackageMappingTab` / `QuartDefaultsTab` (number
inputs + a `<select>` + a `Toggle`, all onBlur/onChange), Weekly Count (`WeeklyPage.tsx`),
Recounts (`monthend/RecountsTab.tsx`, `CountsResultsTable.tsx`).

**Gotchas:**
- **Never put an `onClick` on the whole `<tr>`** if any cell contains selectable text or an
  input — a real bug: a whole-row click-to-open-edit-form silently ate clicks meant to select
  text inside the row. If a row needs a click action, put it on a specific cell/icon, or use
  Template 3 (modal) instead.
- Prefer `onBlur` (commit on leaving the field) over `onChange` (commit on every keystroke) for
  text/number inputs — avoids a network round-trip per keystroke. `Toggle`/`<select>` commit
  immediately on change, which is fine since they're discrete choices.
- Show the save failing — `toast.error()` on a failed update, don't let it silently revert.
- If most columns are read-only and only one or two are editable, that's still this template —
  don't split it into "half DataTable, half something else."

---

## Template 3 — Read Table + Edit Modal

**Use for:** a row that needs a real form to edit — more fields than fit in a cell, a
multi-step edit, or a row whose own text needs to stay selectable/copyable so an inline input
can't safely sit on top of it.

**Pattern:** the table itself is Template 1 (or a lighter read-only `<table>` if it's small and
export/filter genuinely don't apply) — display-only, with an explicit **Edit button or pencil
icon per row** (never a bare row `onClick`, same reasoning as Template 2's gotcha). Clicking it
opens a `Modal` with the edit form. One shared modal component handles both "add" and "edit"
where that's natural, or two clearly-separated components if add and edit forms differ enough
(see the Orders v2 Exceptions note below for why that split sometimes matters).

```tsx
const [editing, setEditing] = useState<Row | null>(null)

// in the table:
<button onClick={() => setEditing(row)} title="Edit">✎</button>

// outside the table:
{editing && (
  <EditRowModal row={editing} onClose={() => setEditing(null)} onSaved={reload} />
)}
```

**Real examples:** `modules/admin/UsersPage.tsx` (`ManageUserModal`), `DroptopPackagesPage.tsx`
(click a price → `PackageDetailModal`), `orders-v2/OrdersV2Exceptions.tsx`
(`ExceptionEditModal`, also reachable from Location Lookup's Order Config table for the same
shop+product).

**Gotchas:**
- If the table's top ever doubles as an "Add new" form (a row of inputs above the list), keep
  **Add** and **Edit** fully separate — a shared "Add" form that also gets silently repopulated
  by clicking a row to edit is the exact bug `OrdersV2Exceptions.tsx` had to fix: clicking a row
  to select/copy its Notes text was overwriting whatever new entry was mid-typed in the Add
  form above it.
- The modal should load/save through its own hook or direct query, not assume the parent
  table's data shape — makes it reusable from more than one entry point (the exception modal
  above is opened both from its own page and from Location Lookup).

---

## Template 4 — Import / Paste Preview

**Use for:** showing the user what's about to be committed *before* they commit it — a CSV/XLSX
upload, a paste-from-Excel, a bulk import. This is a confirmation step, not a workspace: no
sorting, no filtering, no inline editing (fix the source file/paste and re-run instead).

**Status:** not a shared component yet — duplicated close to identically in ~6 places. Until
it's extracted, copy the shape below (and note in your PR that this is a candidate for
extraction, so the next session doing table work can pull it out for real).

```tsx
<div className="overflow-auto rounded border border-navy/30 max-h-72">
  <table className="w-full text-xs font-mono">
    <thead className="sticky top-0 bg-cream">
      <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
        {headers.map((h) => <th key={h} className="px-2 py-1.5 text-left whitespace-nowrap">{h}</th>)}
      </tr>
    </thead>
    <tbody>
      {rows.slice(0, PREVIEW_LIMIT).map((r, i) => (
        <tr key={i} className={i % 2 ? 'bg-navy/[0.02]' : ''}>{/* cells */}</tr>
      ))}
    </tbody>
  </table>
</div>
{rows.length > PREVIEW_LIMIT && (
  <p className="text-[11px] font-mono text-inky/60">
    Showing first {PREVIEW_LIMIT} of {rows.length} rows.
  </p>
)}
```

**Real examples:** `components/upload/ColumnMapper.tsx`, `components/integrations
/OrderConfigImportPanel.tsx`, `modules/issues/IssueImportModal.tsx`, outlier's
`components/paste/PastePreview.tsx` / `XlsxMapper.tsx`.

**Gotchas:**
- Always cap the preview (10–50 rows is typical here) and say how many rows total — never
  render an unbounded parsed file straight into the DOM.
- This almost always lives inside a `Modal`, with the real "Confirm import" action below it,
  not in the table itself.

---

## Template 5 — Matrix / Pinned-Column Grid

**Use for:** genuinely two-dimensional data — a shop × package price matrix, a location ×
month rollup — where the first column (and/or the header row) needs to stay visible while the
rest scrolls, and sometimes the columns themselves are user-orderable.

**Status:** also not a shared component yet — each instance hand-rolls its own sticky
positioning. Copy the z-index/sticky scheme below exactly; getting the stacking order wrong is
the easiest way to end up with a frozen column that scrolls under its own header.

```tsx
<div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
  <table className="text-xs font-mono border-separate border-spacing-0">
    <thead>
      <tr className="bg-cream text-inky uppercase tracking-wide">
        {/* frozen corner cell: sticky BOTH axes, highest z-index */}
        <th className="sticky left-0 top-0 z-20 bg-cream px-3 py-2 text-left border-b border-r border-navy/30">
          Shop
        </th>
        {/* frozen header row only */}
        {columns.map((c) => (
          <th key={c} className="sticky top-0 z-10 bg-cream px-3 py-2 text-right border-b border-navy/30">
            {c}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((r) => (
        <tr key={r.id}>
          {/* frozen first column only */}
          <td className="sticky left-0 z-10 bg-cream px-3 py-2 border-r border-navy/30">{r.label}</td>
          {columns.map((c) => <td key={c} className="px-3 py-2 text-right">{r[c]}</td>)}
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

Z-index rule: **corner cell (sticky both axes) > sticky header row = sticky first column** —
if the corner isn't strictly highest, it gets scrolled under by whichever of the header/column
it ties with.

If columns need to be user-reorderable, wrap the header row in dnd-kit's `DndContext` /
`SortableContext` and persist the order via `useAppSetting` (company-wide) or a sidebar-prefs
style per-user key — see `DroptopPackagesPage.tsx` for a working column-reorder + persisted
order example.

**Real examples:** `modules/customers/DroptopPackagesPage.tsx` (sticky shop column, draggable
package columns), `monthend/RecountHistoryTab.tsx` (sticky location column, one column per
month), `projects/ProjectsModule.tsx`'s subtask grid (sticky control columns, dnd-kit reorder).

---

## Quick reference

| Behavior | Template |
|---|---|
| Browse / sort / filter / export a list | **1 — Data Table** |
| Same, but a few columns are directly editable | **2 — Inline-Editable Data Table** |
| Editing a row needs a real form | **3 — Read Table + Edit Modal** |
| Reviewing rows before a bulk commit | **4 — Import / Paste Preview** |
| Two-dimensional / matrix data, frozen row or column | **5 — Matrix / Pinned-Column Grid** |
| Building an HTML string only for clipboard-paste-into-Excel | *(not a UI table — plain string helper, not one of the 5)* |

## Standing rules for any of the 5

- Loading, empty, and error states are not optional (`CLAUDE.md` rule 7) — every template above
  should show a spinner while loading, a real message when there's nothing to show, and a
  `toast.error()` (or inline message) on a failed save/load, never a silent no-op.
- Brand tokens only — `text-navy`, `bg-cream`, `border-navy/30`, etc. No new hex values.
- Dense and readable — this is an internal ops tool, not a marketing page; avoid oversized
  padding on operational tables.
