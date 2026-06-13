import { flexRender, type Table as TTable } from '@tanstack/react-table'
import { Button, Input } from '@/components/ui'
import { exportTableToCsv } from '@/hooks/useTable'
import { ColumnFilter } from '@/components/shared/ColumnFilter'

interface DataTableProps<T> {
  table: TTable<T>
  globalFilter: string
  onGlobalFilterChange: (v: string) => void
  exportFilename?: string
  // Widened to unknown[] so callers can export a flattened/custom CSV shape
  // independent of the table's row type.
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
          <div className="absolute left-0 top-full mt-1 hidden group-hover:flex flex-col bg-[#161820] border border-[#2a2d3e] rounded shadow-xl z-20 min-w-[160px] py-1">
            {table.getAllLeafColumns().map((col) => (
              <label key={col.id} className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={col.getIsVisible()}
                  onChange={col.getToggleVisibilityHandler()}
                  className="accent-[#00e5ff]"
                />
                <span className="text-xs font-mono text-gray-300">{String(col.columnDef.header ?? col.id)}</span>
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
      <div className="overflow-auto rounded border border-[#2a2d3e]">
        <table className="w-full text-xs font-mono">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-[#2a2d3e] bg-[#161820]">
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    style={header.column.getIsPinned() === 'left'
                      ? { position: 'sticky', left: header.column.getStart('left'), zIndex: 20 }
                      : undefined}
                    className={[
                      'px-3 py-2 text-left text-gray-500 uppercase tracking-wide whitespace-nowrap',
                      header.column.getIsPinned() === 'left' ? 'bg-[#161820] border-r border-[#2a2d3e]' : '',
                    ].join(' ')}
                  >
                    <span
                      onClick={header.column.getToggleSortingHandler()}
                      className={header.column.getCanSort() ? 'cursor-pointer hover:text-gray-300' : ''}
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
                <td colSpan={100} className="px-3 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={100} className="px-3 py-8 text-center text-gray-600">
                  No data
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-[#2a2d3e]/50 hover:bg-[#00e5ff]/5 transition-colors"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      style={cell.column.getIsPinned() === 'left'
                        ? { position: 'sticky', left: cell.column.getStart('left'), zIndex: 10 }
                        : undefined}
                      className={[
                        'px-3 py-2 text-gray-300',
                        cell.column.getIsPinned() === 'left' ? 'bg-[#0f1117] border-r border-[#2a2d3e]' : '',
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
      <div className="flex items-center justify-between text-xs font-mono text-gray-500">
        <span>
          {table.getFilteredRowModel().rows.length.toLocaleString()} rows
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="px-2 py-1 border border-[#2a2d3e] rounded disabled:opacity-30 hover:border-gray-500"
          >
            ‹ Prev
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount()}
          </span>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="px-2 py-1 border border-[#2a2d3e] rounded disabled:opacity-30 hover:border-gray-500"
          >
            Next ›
          </button>
        </div>
      </div>
    </div>
  )
}
