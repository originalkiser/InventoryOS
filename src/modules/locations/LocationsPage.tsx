import { useMemo, useState, useRef, useEffect } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useColumnVisibility } from '@/hooks/useColumnVisibility'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import type { Location } from '@/types'
import { format, parseISO } from 'date-fns'

const col = createColumnHelper<Location>()

export function LocationsPage() {
  const { data, loading } = useConfigTab<Location>('locations', 'core')
  const { active: customFields } = useCustomFields('locations')
  const [colsOpen, setColsOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!colsOpen) return
    function handleClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setColsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [colsOpen])

  const columns = useMemo(() => {
    const cols: any[] = [
      col.accessor('location_code', { id: 'location_code', header: 'Code' }),
      col.accessor('name', { id: 'name', header: 'Name' }),
      col.accessor('region', { id: 'region', header: 'Region', cell: (i) => i.getValue() ?? '—' }),
    ]
    for (const f of customFields) {
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.label,
        accessorFn: (r: Location) => (r.metadata as any)?.[f.field_key] ?? '',
        cell: (i: any) => i.getValue() || '—',
      })
    }
    cols.push(col.accessor('active', {
      id: 'active',
      header: 'Active',
      cell: (i) => (
        <span className={i.getValue() ? 'text-green-600 dark:text-green-400' : 'text-inky/50'}>
          {i.getValue() ? 'Active' : 'Inactive'}
        </span>
      ),
    }))
    cols.push(col.accessor('updated_at', {
      id: 'updated_at',
      header: 'Last Updated',
      cell: (i) => {
        const r = i.row.original as Location
        const src = r.last_change_source ? ` · ${r.last_change_source}` : ''
        return i.getValue() ? `${format(parseISO(i.getValue()), 'MMM d, yyyy')}${src}` : '—'
      },
    }))
    return cols
  }, [customFields])

  const { table, globalFilter, setGlobalFilter, columnVisibility } = useTable(data, columns)
  useColumnVisibility('locations', table, columnVisibility)

  const allColumns = table.getAllLeafColumns().filter((c) => c.id !== 'location_code' && c.id !== 'name')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Locations</h1>
        <p className="text-xs text-inky mt-0.5">All locations in your workspace — read-only view</p>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="locations.csv"
        exportData={data}
        loading={loading}
        actions={
          <div className="relative" ref={popoverRef}>
            <button
              onClick={() => setColsOpen((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              Columns
            </button>
            {colsOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 w-52 bg-cream border border-navy/20 rounded shadow-lg p-2 flex flex-col gap-0.5">
                {allColumns.map((column) => (
                  <label key={column.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-navy/5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={column.getIsVisible()}
                      onChange={column.getToggleVisibilityHandler()}
                      className="accent-navy w-3.5 h-3.5 rounded"
                    />
                    <span className="text-xs font-mono text-navy truncate">
                      {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        }
      />
    </div>
  )
}
