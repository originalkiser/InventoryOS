import { useMemo, useState, useRef, useEffect } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import type { Location } from '@/types'
import { format, parseISO } from 'date-fns'

const col = createColumnHelper<Location>()

const PINNED: string[] = []

// Drag-to-reorder row inside the Columns popover
function SortableColRow({
  id,
  label,
  visible,
  onToggle,
}: {
  id: string
  label: string
  visible: boolean
  onToggle: (event: unknown) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-1.5 rounded select-none ${isDragging ? 'opacity-50 bg-navy/5' : 'hover:bg-navy/5'}`}
    >
      <span
        {...attributes}
        {...listeners}
        className="text-inky/30 hover:text-inky/60 cursor-grab active:cursor-grabbing flex-shrink-0"
        title="Drag to reorder"
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 4a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 8a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 12a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 16a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
      </span>
      <input
        type="checkbox"
        checked={visible}
        onChange={onToggle}
        className="accent-navy w-3.5 h-3.5 rounded flex-shrink-0"
      />
      <span className="text-xs font-mono text-navy truncate">{label}</span>
    </div>
  )
}

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

  const baseColumns = useMemo(() => {
    const cols: any[] = [
      col.accessor('location_code', { id: 'location_code', header: 'Code' }),
      col.accessor('name', { id: 'name', header: 'Name' }),
      col.accessor('region', { id: 'region', header: 'Region', cell: (i) => i.getValue() ?? '—' }),
      {
        id: 'market',
        header: 'Market',
        accessorFn: (r: Location) => (r.metadata as any)?.market ?? '',
        cell: (i: any) => i.getValue() || '—',
      },
      {
        id: 'area_manager',
        header: 'Area Manager',
        accessorFn: (r: Location) => (r.metadata as any)?.area_manager ?? '',
        cell: (i: any) => i.getValue() || '—',
      },
      {
        id: 'director',
        header: 'Director',
        accessorFn: (r: Location) => (r.metadata as any)?.director ?? '',
        cell: (i: any) => i.getValue() || '—',
      },
    ]
    for (const f of customFields) {
      if (['market', 'area_manager', 'director'].includes(f.field_key)) continue
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

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(data, baseColumns)
  useColumnPrefs('core.locations', table, columnVisibility, columnOrder, setColumnOrder)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // All non-pinned columns, in current order
  const manageableCols = useMemo(() => {
    const all = table.getAllLeafColumns().filter((c) => !PINNED.includes(c.id))
    if (columnOrder.length > 0) {
      const ordered = [...all].sort((a, b) => {
        const ia = columnOrder.indexOf(a.id)
        const ib = columnOrder.indexOf(b.id)
        if (ia === -1 && ib === -1) return 0
        if (ia === -1) return 1
        if (ib === -1) return -1
        return ia - ib
      })
      return ordered
    }
    return all
  }, [table, columnOrder, columnVisibility]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = manageableCols.map((c) => c.id)
    const oldIdx = ids.indexOf(String(active.id))
    const newIdx = ids.indexOf(String(over.id))
    const reordered = arrayMove(ids, oldIdx, newIdx)
    const allIds = [...PINNED, ...reordered]
    setColumnOrder(allIds)
  }

  function resetToDefault() {
    setColumnOrder([])
    table.resetColumnVisibility()
  }

  const colLabel = (c: ReturnType<typeof table.getAllLeafColumns>[number]) =>
    typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id

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
        hideColumnControl
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
              <div className="absolute right-0 top-full mt-1 z-20 w-56 bg-cream border border-navy/20 rounded shadow-lg p-2 flex flex-col gap-1">
                <div className="flex items-center justify-between px-1 pb-1 border-b border-navy/10 mb-0.5">
                  <span className="text-[10px] font-mono text-inky/50 uppercase tracking-wide">Drag to reorder · Toggle to show/hide</span>
                </div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={manageableCols.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                    {manageableCols.map((column) => (
                      <SortableColRow
                        key={column.id}
                        id={column.id}
                        label={colLabel(column)}
                        visible={column.getIsVisible()}
                        onToggle={column.getToggleVisibilityHandler()}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
                <div className="border-t border-navy/10 mt-1 pt-1">
                  <button
                    onClick={resetToDefault}
                    className="w-full text-left px-2 py-1 text-[10px] font-mono text-inky/50 hover:text-navy transition-colors rounded hover:bg-navy/5"
                  >
                    Reset to Default
                  </button>
                </div>
              </div>
            )}
          </div>
        }
      />
    </div>
  )
}
