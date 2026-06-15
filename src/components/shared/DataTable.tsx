import { flexRender, type Table as TTable } from '@tanstack/react-table'
import { Button, Input } from '@/components/ui'
import { exportTableToCsv } from '@/hooks/useTable'
import { ColumnFilter } from '@/components/shared/ColumnFilter'

interface DataTableProps<T> {
  table: TTable<T>
  globalFilter: string
  onGlobalFilterChange: (v: string) => void
  exportFilename?: string
  exportData?: unknown[]
  loading?: boolean
  actions?: React.ReactNode
}

export function DataTable<T>({
  table,
  globalFilter,
  onGlobalFilterChange,
  exportFilename,
  exportData,
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
          className="w-52"
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
        {exportFilename && exportData && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => exportTableToCsv(exportData, exportFilename)}
          >
            Export CSV
          </Button>
        )}
        {actions}
      </div>

      {/* Table */}
      <div className="overflow-auto rounded border border-inky/20">
        <table className="w-full text-xs font-body">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-inky/20 bg-navy">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    style={header.column.getIsPinned() === 'left'
                      ? { position: 'sticky', left: header.column.getStart('left'), zIndex: 20 }
                      : undefined}
                    className={[
                      'px-3 py-2 text-left text-cream font-heading text-sm uppercase tracking-wide whitespace-nowrap',
                      header.column.getIsPinned() === 'left' ? 'bg-navy border-r-2 border-r-inky/40' : '',
                    ].join(' ')}
                  >
                    <span
                      onClick={header.column.getToggleSortingHandler()}
                      className={header.column.getCanSort() ? 'cursor-pointer hover:text-sky' : ''}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === 'asc' && ' ↑'}
                      {header.column.getIsSorted() === 'desc' && ' ↓'}
                    </span>
                    {header.column.getCanFilter() && <ColumnFilter column={header.column} />}
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
                    i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8]',
                  ].join(' ')}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={cell.column.getIsPinned() === 'left'
                        ? { position: 'sticky', left: cell.column.getStart('left'), zIndex: 10 }
                        : undefined}
                      className={[
                        'px-3 py-2 text-navy',
                        cell.column.getIsPinned() === 'left'
                          ? `${i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8]'} border-r-2 border-r-inky/20`
                          : '',
                      ].join(' ')}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
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
