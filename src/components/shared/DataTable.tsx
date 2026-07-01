import { useEffect, useRef, useState } from 'react'
import { flexRender, type Row, type Table as TTable } from '@tanstack/react-table'
import { Button, Input, SbLoader } from '@/components/ui'
import { ColumnFilter } from '@/components/shared/ColumnFilter'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'

interface DataTableProps<T> {
  table: TTable<T>
  globalFilter: string
  onGlobalFilterChange: (v: string) => void
  exportFilename?: string
  /** @deprecated Export now uses visible table state. This prop is ignored. */
  exportData?: unknown[]
  loading?: boolean
  actions?: React.ReactNode
  /** When set, adds "Export with Files (ZIP)" option that bundles attachments */
  attachmentEntityType?: 'issue' | 'project'
  /** Suppress the built-in column visibility dropdown (use when the caller provides its own) */
  hideColumnControl?: boolean
  /** Called whenever the internal row-selection Set changes */
  onSelectionChange?: (ids: Set<string>) => void
}

// ── Export helpers ────────────────────────────────────────────────────────────

function makeExportLabel(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')               // strip extension
    .replace(/_\d{4}[_-].*$/, '')          // strip _2026-01-01 date suffixes
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Export'
}

function makeExportName(filename: string): string {
  const label = makeExportLabel(filename)
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${label} Export- ${mm}.${dd}.${d.getFullYear()}`
}

function getExportCols<T>(table: TTable<T>) {
  return table.getVisibleLeafColumns().filter((c) => {
    const h = String(c.columnDef.header ?? '')
    return h !== '' && !['select', 'edit', 'attachments'].includes(c.id)
  })
}

function rowsToCsv<T>(rows: Row<T>[], cols: ReturnType<typeof getExportCols<T>>): string {
  const headers = cols.map((c) => String(c.columnDef.header ?? c.id))
  const dataRows = rows.map((row) =>
    cols.map((col) => {
      const val = row.getValue(col.id)
      if (val == null) return ''
      const s = typeof val === 'object' ? JSON.stringify(val) : String(val)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    })
  )
  return [headers, ...dataRows].map((r) => r.join(',')).join('\n')
}

function rowsToXlsxBuffer<T>(
  rows: Row<T>[],
  cols: ReturnType<typeof getExportCols<T>>,
  sheetName: string
): ArrayBuffer {
  const headers = cols.map((c) => String(c.columnDef.header ?? c.id))
  const dataRows = rows.map((row) =>
    cols.map((col) => {
      const val = row.getValue(col.id)
      if (val == null) return ''
      return typeof val === 'object' ? JSON.stringify(val) : val
    })
  )
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31))
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const SEL_W = 36

// ── Component ─────────────────────────────────────────────────────────────────

export function DataTable<T>({
  table,
  globalFilter,
  onGlobalFilterChange,
  exportFilename,
  loading,
  actions,
  attachmentEntityType,
  hideColumnControl,
  onSelectionChange,
}: DataTableProps<T>) {
  // ── Selection state (keyed by row's `id` field, so it persists across pages)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])

  function rowKey(row: Row<T>): string {
    return String((row.original as any)?.id ?? row.id)
  }

  const filteredRows = table.getFilteredRowModel().rows
  const currentPageRows = table.getRowModel().rows
  const isAllPageSelected =
    currentPageRows.length > 0 && currentPageRows.every((r) => selectedIds.has(rowKey(r)))
  const isSomePageSelected = currentPageRows.some((r) => selectedIds.has(rowKey(r))) && !isAllPageSelected
  const selectedCount = filteredRows.filter((r) => selectedIds.has(rowKey(r))).length
  const hasFill = table.getVisibleLeafColumns().some(c => (c.columnDef.meta as any)?.fill)

  // Wire the indeterminate state — can't be set in JSX directly, needs a DOM ref.
  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = isSomePageSelected
  }, [isSomePageSelected])

  function toggleAllPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (isAllPageSelected) currentPageRows.forEach((r) => next.delete(rowKey(r)))
      else currentPageRows.forEach((r) => next.add(rowKey(r)))
      return next
    })
  }

  function toggleRow(row: Row<T>) {
    const key = rowKey(row)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Rows that will be exported: selected (if any) or all filtered.
  const exportRows =
    selectedCount > 0 ? filteredRows.filter((r) => selectedIds.has(rowKey(r))) : filteredRows
  const exportName = exportFilename ? makeExportName(exportFilename) : ''

  // ── Export dropdown ──────────────────────────────────────────────────────────
  const [exportOpen, setExportOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!exportOpen) return
    const handler = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportOpen])

  async function doExport(format: 'csv' | 'xlsx' | 'zip') {
    if (!exportFilename) return
    setExporting(true)
    setExportOpen(false)
    try {
      const cols = getExportCols(table)
      const label = makeExportLabel(exportFilename)
      const name = exportName

      if (format === 'csv') {
        const csv = rowsToCsv(exportRows, cols)
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${name}.csv`)
        toast.success(`${name}.csv downloaded`)
      } else if (format === 'xlsx') {
        const buf = rowsToXlsxBuffer(exportRows, cols, label)
        triggerDownload(
          new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `${name}.xlsx`
        )
        toast.success(`${name}.xlsx downloaded`)
      } else if (format === 'zip') {
        const zip = new JSZip()

        // Always include CSV data
        zip.file(`${name}.csv`, rowsToCsv(exportRows, cols))

        // Fetch and bundle attachments
        if (attachmentEntityType) {
          const ids = exportRows.map((r) => (r.original as any)?.id).filter(Boolean)
          if (ids.length) {
            const { data: atts } = await (supabase as any)
              .schema('platform').from('attachments')
              .select('*')
              .in('entity_id', ids)

            if ((atts ?? []).length > 0) {
              const folder = zip.folder('Attachments')!
              let fetched = 0
              for (const att of atts ?? []) {
                try {
                  const { data } = await supabase.storage
                    .from('attachments')
                    .download(att.storage_path)
                  if (data) {
                    // Prefix entity id to avoid filename collisions
                    folder.file(att.file_name, data)
                    fetched++
                  }
                } catch { /* skip individual failures */ }
              }
              toast.success(`${name}.zip — data + ${fetched} file${fetched !== 1 ? 's' : ''} bundled`)
            } else {
              toast.success(`${name}.zip — no attachments found, data only`)
            }
          }
        }

        const blob = await zip.generateAsync({ type: 'blob' })
        triggerDownload(blob, `${name}.zip`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search..."
          value={globalFilter}
          onChange={(e) => onGlobalFilterChange(e.target.value)}
          className="w-full sm:w-52"
        />

        {/* Column visibility — exclude the internal select column */}
        {!hideColumnControl && (
          <div className="relative group">
            <Button variant="secondary" size="sm">Columns</Button>
            <div className="absolute left-0 top-full mt-1 hidden group-hover:flex flex-col bg-cream border border-navy/40 rounded shadow-xl z-20 min-w-[160px] py-1">
              {table.getAllLeafColumns().filter((c) => c.id !== 'select').map((col) => (
                <label key={col.id} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-navy/5">
                  <input
                    type="checkbox"
                    checked={col.getIsVisible()}
                    onChange={col.getToggleVisibilityHandler()}
                    className="accent-inky"
                  />
                  <span className="text-xs font-body text-navy">{String(col.columnDef.header ?? col.id)}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Export button + dropdown */}
        {exportFilename && (
          <div ref={exportMenuRef} className="relative">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setExportOpen((o) => !o)}
              disabled={exporting}
            >
              {exporting ? 'Exporting…' : 'Export ▾'}
            </Button>
            {exportOpen && (
              <div className="absolute left-0 top-full mt-1 z-30 bg-cream border border-navy/30 rounded shadow-xl min-w-[210px] py-1">
                {selectedCount > 0 ? (
                  <div className="px-3 py-1.5 text-[10px] font-mono text-sky border-b border-inky/10">
                    {selectedCount} row{selectedCount !== 1 ? 's' : ''} selected
                  </div>
                ) : (
                  <div className="px-3 py-1.5 text-[10px] font-mono text-inky/50 border-b border-inky/10">
                    All {filteredRows.length} row{filteredRows.length !== 1 ? 's' : ''}
                  </div>
                )}
                <button
                  onClick={() => doExport('csv')}
                  className="w-full text-left px-3 py-2 text-xs font-mono text-navy hover:bg-navy/5"
                >
                  Export as CSV
                </button>
                <button
                  onClick={() => doExport('xlsx')}
                  className="w-full text-left px-3 py-2 text-xs font-mono text-navy hover:bg-navy/5"
                >
                  Export as XLSX
                </button>
                {attachmentEntityType && (
                  <button
                    onClick={() => doExport('zip')}
                    className="w-full text-left px-3 py-2 text-xs font-mono text-navy hover:bg-navy/5 border-t border-inky/10"
                  >
                    Export with Files (ZIP)
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Selection badge */}
        {selectedCount > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-mono text-sky">
            {selectedCount} selected
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-inky/40 hover:text-red-400 text-[10px]"
              title="Clear selection"
            >
              ✕
            </button>
          </span>
        )}

        {actions}
      </div>

      {/* Table */}
      <div className="overflow-auto rounded border border-inky/20 max-h-[calc(100vh-300px)]">
        <table
          className={`text-xs font-body table-fixed${hasFill ? ' w-full' : ''}`}
          style={hasFill ? { minWidth: table.getTotalSize() + SEL_W } : { width: table.getTotalSize() + SEL_W }}
        >
          <thead className="sticky top-0 z-20">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-inky/20 bg-[#002745]">
                {/* Select-all checkbox */}
                <th
                  style={{ width: SEL_W, minWidth: SEL_W }}
                  className="px-2 py-2 text-center"
                >
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={isAllPageSelected}
                    onChange={toggleAllPage}
                    className="accent-sky cursor-pointer"
                    aria-label="Select all on this page"
                  />
                </th>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      ...((header.column.columnDef.meta as any)?.fill
                        ? { minWidth: header.getSize() }
                        : { width: header.getSize() }),
                      ...(header.column.getIsPinned() === 'left'
                        ? { position: 'sticky', left: header.column.getStart('left') + SEL_W, zIndex: 20 }
                        : { position: 'relative' }),
                    }}
                    className={[
                      'px-3 py-2 text-left text-[#F2F1E6] font-heading text-sm uppercase tracking-wide overflow-hidden',
                      header.column.getIsPinned() === 'left' ? 'bg-[#002745] border-r-2 border-r-inky/40' : '',
                    ].join(' ')}
                  >
                    <span
                      onClick={header.column.getToggleSortingHandler()}
                      className={['block truncate', header.column.getCanSort() ? 'cursor-pointer hover:text-sky' : ''].join(' ')}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </span>
                    {header.column.getCanFilter() && <ColumnFilter column={header.column} />}
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={[
                          'absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none',
                          header.column.getIsResizing() ? 'bg-[#00e5ff]' : 'bg-[#F2F1E6]/10 hover:bg-[#00e5ff]/60',
                        ].join(' ')}
                      />
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={100} className="px-3 py-8"><div className="flex justify-center"><SbLoader size={32} /></div></td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={100} className="px-3 py-8 text-center text-inky font-body italic">No entries yet. Add one to get started.</td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, i) => {
                const selected = selectedIds.has(rowKey(row))
                return (
                  <tr
                    key={row.id}
                    className={[
                      'border-b border-inky/10 hover:bg-sky/10 transition-colors',
                      selected
                        ? 'bg-sky/15'
                        : i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8] dark:bg-[#0D2035]',
                    ].join(' ')}
                  >
                    {/* Row checkbox */}
                    <td
                      style={{ width: SEL_W, minWidth: SEL_W }}
                      className="px-2 py-2 text-center"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRow(row)}
                        className="accent-sky cursor-pointer"
                        aria-label="Select row"
                      />
                    </td>
                    {row.getVisibleCells().map((cell) => {
                      const noClip = (cell.column.columnDef.meta as any)?.noClip
                      const isFill = (cell.column.columnDef.meta as any)?.fill
                      return (
                        <td
                          key={cell.id}
                          style={{
                            ...(isFill
                              ? { minWidth: cell.column.getSize() }
                              : { width: cell.column.getSize(), maxWidth: cell.column.getSize() }),
                            ...(noClip || isFill ? {} : { overflow: 'hidden', textOverflow: 'ellipsis' }),
                            ...(cell.column.getIsPinned() === 'left'
                              ? { position: 'sticky', left: cell.column.getStart('left') + SEL_W, zIndex: 10 }
                              : {}),
                          }}
                          className={[
                            'px-3 py-2 text-navy',
                            noClip ? '' : 'whitespace-nowrap',
                            cell.column.getIsPinned() === 'left'
                              ? `${selected || i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8] dark:bg-[#0D2035]'} border-r-2 border-r-inky/20`
                              : '',
                          ].join(' ')}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      )
                    })}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination + row count */}
      <div className="flex items-center justify-between text-xs font-body text-inky flex-wrap gap-2">
        <span>
          {filteredRows.length.toLocaleString()} rows
          {selectedCount > 0 && (
            <span className="text-sky ml-2">· {selectedCount} selected</span>
          )}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={table.getState().pagination.pageSize >= 999999 ? 'all' : table.getState().pagination.pageSize}
            onChange={(e) => {
              const v = e.target.value
              table.setPageSize(v === 'all' ? 999999 : Number(v))
              table.setPageIndex(0)
            }}
            className="border border-navy/40 rounded px-2 py-1 text-xs font-body text-navy bg-cream focus:outline-none focus:border-navy"
          >
            {[50, 100, 150, 200].map((n) => (
              <option key={n} value={n}>{n} per page</option>
            ))}
            <option value="all">All</option>
          </select>
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="px-2 py-1 border border-navy/40 rounded disabled:opacity-30 hover:border-navy text-navy font-heading text-xs uppercase"
          >
            ‹ Prev
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount() || 1}
          </span>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="px-2 py-1 border border-navy/40 rounded disabled:opacity-30 hover:border-navy text-navy font-heading text-xs uppercase"
          >
            Next ›
          </button>
        </div>
      </div>
    </div>
  )
}
