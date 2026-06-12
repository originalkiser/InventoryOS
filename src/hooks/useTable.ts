import { useState, useMemo } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table'

export function useTable<T>(data: T[], columns: ColumnDef<T, any>[]) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 50 } },
    // Callers often pass a freshly-filtered/mapped array each render (e.g. a new
    // reference even when contents are unchanged). With autoResetPageIndex on
    // (the default), that fires a page-index reset on every render, and any
    // subsequent state change spins into a render loop that locks the main
    // thread. We don't need page auto-reset, so disable it.
    autoResetPageIndex: false,
  })

  return { table, globalFilter, setGlobalFilter, columnVisibility }
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
