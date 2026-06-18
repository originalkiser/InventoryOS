import { flexRender, type Table as TTable } from '@tanstack/react-table'
import { Button, Input } from '@/components/ui'
import { ColumnFilter } from '@/components/shared/ColumnFilter'

interface DataTableProps<T> {
  table: TTable<T>
  globalFilter: string
  onGlobalFilterChange: (v: string) => void
  exportFilename?: string
  /** @deprecated Export now uses visible table state. This prop is ignored. */
  exportData?: unknown[]
  loading?: boolean
  actions?: React.ReactNode
}

function exportFromTable<T>(table: TTable<T>, filename: string) {
  const visibleCols = table.getVisibleLeafColumns().filter((c) => {
    const h = String(c.columnDef.header ?? '')
    return h !== ''
  })
  const headers = visibleCols.map((c) => String(c.columnDef.header ?? c.id))
  const rows = table.getFilteredRowModel().rows.map((row) =>
    visibleCols.map((col) => {
      const val = row.getValue(col.id)
      if (val == null) return ''
      if (typeof val === 'object') return JSON.stringify(val)
      return String(val)
    })
  )
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export function DataTable<T>({
  table,
  globalFilter,
  onGlobalFilterChange,
  exportFilename,
  loading,
  actions,
}: DataTableProps<T>) {
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
        {/* Column visibility */}
        <div className="relative group">
          <Button variant="secondary" size="sm">
            Columns
          </Button>
          <div className="absolute left-0 top-full mt-1 hidden group-hover:flex flex-col bg-cream border border-navy/40 rounded shadow-xl z-20 min-w-[160px] py-1">
            {table.getAllLeafColumns().map((col) => (
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
        {exportFilename && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => exportFromTable(table, exportFilename)}
          >
            Export CSV
          </Button>
        )}
        {actions}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded border border-inky/20">
        <table
          className="text-xs font-body table-fixed"
          style={{ width: table.getTotalSize() }}
        >
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-inky/20 bg-[#002745]">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    style={{
                      width: header.getSize(),
                      ...(header.column.getIsPinned() === 'left'
                        ? { position: 'sticky', left: header.column.getStart('left'), zIndex: 20 }
                        : { position: 'relative' }),
                    }}
                    className={[
                      'px-3 py-2 text-left text-[#F2F1E6] font-heading text-sm uppercase tracking-wide overflow-hidden',
                      header.column.getIsPinned() === 'left' ? 'bg-[#002745] border-r-2 border-r-inky/40' : '',
                    ].join(' ')}
                  >
                    <span
                      onClick={header.column.getToggleSortingHandler()}
                      className={[
                        'block truncate',
                        header.column.getCanSort() ? 'cursor-pointer hover:text-sky' : '',
                      ].join(' ')}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </span>
                    {header.column.getCanFilter() && <ColumnFilter column={header.column} />}
                    {/* Resize handle */}
                    {header.column.getCanResize() && (
                      <div
                        onMouseDown={header.getResizeHandler()}
                        onTouchStart={header.getResizeHandler()}
                        className={[
                          'absolute top-0 right-0 h-full w-1 cursor-col-resize select-none touch-none',
                          header.column.getIsResizing()
                            ? 'bg-[#00e5ff]'
                            : 'bg-[#F2F1E6]/10 hover:bg-[#00e5ff]/60',
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
                <td colSpan={100} className="px-3 py-8 text-center text-inky font-body italic">
                  Loading
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={100} className="px-3 py-8 text-center text-inky font-body italic">
                  No entries yet. Add one to get started.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, i) => (
                <tr
                  key={row.id}
                  className={[
                    'border-b border-inky/10 hover:bg-sky/20 transition-colors',
                    i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8] dark:bg-[#0D2035]',
                  ].join(' ')}
                >
                  {row.getVisibleCells().map((cell) => {
                    const noClip = (cell.column.columnDef.meta as any)?.noClip
                    return (
                    <td
                      key={cell.id}
                      style={{
                        width: cell.column.getSize(),
                        maxWidth: cell.column.getSize(),
                        ...(noClip ? {} : { overflow: 'hidden', textOverflow: 'ellipsis' }),
                        ...(cell.column.getIsPinned() === 'left'
                          ? { position: 'sticky', left: cell.column.getStart('left'), zIndex: 10 }
                          : {}),
                      }}
                      className={[
                        'px-3 py-2 text-navy',
                        noClip ? '' : 'whitespace-nowrap',
                        cell.column.getIsPinned() === 'left'
                          ? `${i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8] dark:bg-[#0D2035]'} border-r-2 border-r-inky/20`
                          : '',
                      ].join(' ')}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-xs font-body text-inky">
        <span>
          {table.getFilteredRowModel().rows.length.toLocaleString()} rows
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="px-2 py-1 border border-navy/40 rounded disabled:opacity-30 hover:border-navy text-navy font-heading text-xs uppercase"
          >
            ‹ Prev
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
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
