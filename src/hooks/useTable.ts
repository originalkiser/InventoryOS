import { useState, useMemo, useEffect } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ColumnPinningState,
  type ColumnSizingState,
  type FilterFn,
} from '@tanstack/react-table'

// Excel-style multi-select: filter value is an array of allowed display strings.
const multiSelectFilter: FilterFn<any> = (row, columnId, value: string[]) => {
  if (!value || value.length === 0) return true
  return value.includes(String(row.getValue(columnId) ?? ''))
}

// Sort/filter state for a persistKey'd table, keyed by that string alone —
// callers are expected to pass a value unique across the app (e.g.
// "config:vendor_parts").
function loadPersistedTableState(persistKey: string | undefined): { sorting?: SortingState; globalFilter?: string; columnFilters?: ColumnFiltersState } | null {
  if (!persistKey) return null
  try {
    const raw = localStorage.getItem(`tablePrefs:${persistKey}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function useTable<T>(data: T[], columns: ColumnDef<T, any>[], options?: { initialSorting?: SortingState; initialVisibility?: VisibilityState; persistKey?: string }) {
  const persistKey = options?.persistKey
  // Only read once per persistKey (not on every render) — a fresh read here
  // would stomp in-progress edits to the state below with whatever was last
  // written, which is never what a state initializer should do.
  const persisted = useMemo(() => loadPersistedTableState(persistKey), [persistKey])

  const [sorting, setSorting] = useState<SortingState>(persisted?.sorting ?? options?.initialSorting ?? [])
  const [globalFilter, setGlobalFilter] = useState(persisted?.globalFilter ?? '')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(options?.initialVisibility ?? {})
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(persisted?.columnFilters ?? [])
  // Optional ordering/pinning — empty by default, so tables that don't use them
  // are unaffected (no column is pinned/reordered).
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([])
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>({ left: [], right: [] })
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})

  // Sort/filter round-trips through localStorage (opt-in via persistKey) so
  // leaving a table and coming back — e.g. tabbing across Inventory Config
  // sheets to troubleshoot — doesn't lose it.
  useEffect(() => {
    if (!persistKey) return
    try { localStorage.setItem(`tablePrefs:${persistKey}`, JSON.stringify({ sorting, globalFilter, columnFilters })) } catch { /* ignore */ }
  }, [persistKey, sorting, globalFilter, columnFilters])

  const table = useReactTable({
    data,
    columns,
    columnResizeMode: 'onChange',
    state: { sorting, globalFilter, columnVisibility, columnFilters, columnOrder, columnPinning, columnSizing },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnFiltersChange: setColumnFilters,
    onColumnOrderChange: setColumnOrder,
    onColumnPinningChange: setColumnPinning,
    onColumnSizingChange: setColumnSizing,
    defaultColumn: { filterFn: multiSelectFilter, minSize: 40, maxSize: 800 },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 50 } },
    // Callers often pass a freshly-filtered/mapped array each render (e.g. a new
    // reference even when contents are unchanged). With autoResetPageIndex on
    // (the default), that fires a page-index reset on every render, and any
    // subsequent state change spins into a render loop that locks the main
    // thread. We don't need page auto-reset, so disable it.
    autoResetPageIndex: false,
  })

  return { table, globalFilter, setGlobalFilter, columnVisibility, columnFilters, columnOrder, setColumnOrder, columnPinning, setColumnPinning }
}

export function exportTableToCsv<T>(data: T[], filename: string) {
  if (!data.length) return
  const headers = Object.keys(data[0] as object)
  const rows = data.map((row) =>
    headers.map((h) => {
      const v = (row as any)[h]
      if (v === null || v === undefined) return ''
      const s = String(v)
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s
    }).join(',')
  )
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
