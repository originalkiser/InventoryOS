import { useMemo, useState, useRef, useEffect } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocationExclusions, locExclusionValue, ownerBucket } from '@/hooks/useLocationExclusions'
import { LOCATION_FIELDS, LOCATION_FIELD_KEYS, DEFAULT_VISIBLE_LOCATION_COLUMNS } from '@/lib/locationFields'
import { ColumnManagerModal, type ColItem } from './ColumnManagerModal'
import type { VisibilityState } from '@tanstack/react-table'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { DataTable } from '@/components/shared/DataTable'
import { MultiSelectDropdown } from '@/components/ui/MultiSelectDropdown'
import { Button, Card, CardBody } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { Location } from '@/types'
import { format, parseISO } from 'date-fns'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs'
import { MapRoutesTab } from './MapRoutesTab'
import toast from 'react-hot-toast'

// A location created within this window with no location_type set yet
// shows on the "Need Classification" prompt instead of silently joining
// the main list as an assumed oil-change shop. 72h per explicit request —
// wide enough to cover a location added just before a weekend/holiday.
const CLASSIFY_WINDOW_HOURS = 72

const col = createColumnHelper<Location>()

const LOC_FILTER_HIERARCHY = [
  { field: 'meta:owner',             label: 'Owner' },
  { field: 'region',                 label: 'Region' },
  { field: 'meta:market',            label: 'Market' },
  { field: 'meta:area_manager',      label: 'Area Manager' },
  { field: 'meta:regional_director', label: 'Regional Director' },
]
const LS_DROP_FILTERS = 'locations.page.dropFilters'
const LS_HIDDEN_DROPS = 'locations.page.hiddenDropdowns'

// Base-column-first resolution (with metadata fallback) so this read-only view
// mirrors the Global Config locations list. See locExclusionValue.
function locFieldValue(loc: Location, field: string): string {
  return locExclusionValue(loc, field)
}

// Used only for the Owner FILTER dropdown (options + matching) — the
// actual "Owner" data COLUMN still shows the real name via locFieldValue
// above, unchanged. Simplified to Corporate/Franchise here per explicit
// request: dozens of individual franchisee names made the filter
// impractical to use for "show me every franchise location."
function filterFieldValue(loc: Location, field: string): string {
  const raw = locFieldValue(loc, field)
  return field === 'meta:owner' ? ownerBucket(raw) : raw
}

const PINNED: string[] = []

export function LocationsPage() {
  const { data, loading, update } = useConfigTab<Location>('locations', 'core')
  const { filterLocations } = useLocationExclusions()
  const { active: customFields } = useCustomFields('locations')
  const [colsOpen, setColsOpen] = useState(false)
  const [carWashOpen, setCarWashOpen] = useState(false)
  const [closedOpen, setClosedOpen] = useState(false)
  const [classifying, setClassifying] = useState<string | null>(null)

  // Contextual dropdown filter state
  const [dropFilters, setDropFilters] = useState<Record<string, string[]>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_DROP_FILTERS) ?? '{}')
      const result: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(raw)) {
        result[k] = Array.isArray(v) ? (v as string[]) : (v ? [v as string] : [])
      }
      return result
    } catch { return {} }
  })
  const [hiddenDropdowns, setHiddenDropdowns] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(LS_HIDDEN_DROPS) ?? '[]')) } catch { return new Set() }
  })
  const [dropSettingsOpen, setDropSettingsOpen] = useState(false)
  const dropSettingsRef = useRef<HTMLDivElement>(null)

  useEffect(() => { localStorage.setItem(LS_DROP_FILTERS, JSON.stringify(dropFilters)) }, [dropFilters])
  useEffect(() => { localStorage.setItem(LS_HIDDEN_DROPS, JSON.stringify([...hiddenDropdowns])) }, [hiddenDropdowns])

  useEffect(() => {
    if (!dropSettingsOpen) return
    function handleClick(e: MouseEvent) {
      if (dropSettingsRef.current && !dropSettingsRef.current.contains(e.target as Node)) setDropSettingsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropSettingsOpen])

  // Full Global Config field set → read-only columns (base-column-first
  // resolution), plus any custom metadata fields, plus active + updated_at.
  const baseColumns = useMemo(() => {
    const cols: any[] = []
    for (const f of LOCATION_FIELDS) {
      if (f.name === 'region') {
        cols.push(col.accessor('region', { id: 'region', header: 'Region', cell: (i) => i.getValue() ?? '—' }))
        continue
      }
      cols.push({
        id: f.name,
        header: f.label,
        accessorFn: (r: Location) => locFieldValue(r, f.name),
        cell: (i: any) => i.getValue() || '—',
      })
    }
    // Custom metadata fields — skip any that duplicate a base field by key or label.
    const schemaLabels = new Set(LOCATION_FIELDS.map((f) => f.label.toLowerCase()))
    for (const f of customFields) {
      if (LOCATION_FIELD_KEYS.has(f.field_key)) continue
      if (schemaLabels.has((f.label ?? '').toLowerCase())) continue
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.label,
        accessorFn: (r: Location) => locFieldValue(r, f.field_key),
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

  // Default view: key base columns + any custom fields visible; the rest of
  // the Global Config schema hidden (available to add via Manage Columns).
  // Only base columns are enumerated here — they're known synchronously, so
  // useTable's initial snapshot hides them from the first render. Custom
  // fields load async and stay visible by default (matches prior behavior).
  const initialVisibility = useMemo<VisibilityState>(() => {
    const vis: VisibilityState = {}
    for (const f of LOCATION_FIELDS) if (!DEFAULT_VISIBLE_LOCATION_COLUMNS.includes(f.name)) vis[f.name] = false
    return vis
  }, [])

  // Rows passing all filters ABOVE a given hierarchy index (for per-dropdown option counts)
  function rowsAbove(fi: number): Location[] {
    let r = data
    for (let i = 0; i < fi; i++) {
      const vals = dropFilters[LOC_FILTER_HIERARCHY[i].field] ?? []
      if (vals.length) r = r.filter(loc => vals.includes(filterFieldValue(loc, LOC_FILTER_HIERARCHY[i].field)))
    }
    return r
  }

  const filteredData = useMemo(() => {
    let r = filterLocations(data)
    for (const { field } of LOC_FILTER_HIERARCHY) {
      const vals = dropFilters[field] ?? []
      if (vals.length) r = r.filter(loc => vals.includes(filterFieldValue(loc, field)))
    }
    return r
  }, [data, dropFilters, filterLocations])

  // New, unclassified locations get their own action list instead of
  // silently joining the main table as an assumed oil-change shop — see
  // CLASSIFY_WINDOW_HOURS above. Read from `data` (not filteredData) so a
  // new location still shows up here even if the current dropdown filters
  // would otherwise hide it — classifying it isn't optional just because a
  // filter's active.
  const needsClassification = useMemo(() => {
    const cutoff = Date.now() - CLASSIFY_WINDOW_HOURS * 3600_000
    return data
      .filter((l) => !l.location_type && new Date(l.created_at).getTime() >= cutoff)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  }, [data])
  const needsClassificationIds = useMemo(() => new Set(needsClassification.map((l) => l.id)), [needsClassification])

  // Three buckets, mutually exclusive: a pending-classification location is
  // held out of all three (it has its own list above) until resolved;
  // Closed takes priority over Car Wash if somehow both apply, since
  // "closed" is the more operationally important state to separate out.
  const closedLocations = useMemo(
    () => filteredData.filter((l) => !l.active && !needsClassificationIds.has(l.id)),
    [filteredData, needsClassificationIds],
  )
  const carWashLocations = useMemo(
    () => filteredData.filter((l) => l.active && l.location_type === 'car_wash' && !needsClassificationIds.has(l.id)),
    [filteredData, needsClassificationIds],
  )
  const mainTableData = useMemo(
    () => filteredData.filter((l) => l.active && l.location_type !== 'car_wash' && !needsClassificationIds.has(l.id)),
    [filteredData, needsClassificationIds],
  )

  async function classify(id: string, type: 'oil_change' | 'car_wash') {
    setClassifying(id)
    const ok = await update(id, { location_type: type } as Partial<Location>)
    setClassifying(null)
    if (ok) toast.success(`Marked ${type === 'car_wash' ? 'Car Wash' : 'Oil Change'}`)
  }

  function setDropFilter(field: string, vals: string[], fi: number) {
    setDropFilters(prev => {
      const next: Record<string, string[]> = {}
      for (let i = 0; i < fi; i++) next[LOC_FILTER_HIERARCHY[i].field] = prev[LOC_FILTER_HIERARCHY[i].field] ?? []
      next[field] = vals
      return next
    })
  }

  const hasActiveFilters = LOC_FILTER_HIERARCHY.some(({ field }) => (dropFilters[field] ?? []).length > 0)

  const visibleHierarchy = LOC_FILTER_HIERARCHY.filter(({ field }) => {
    if (hiddenDropdowns.has(field)) return false
    const vals = new Set(data.map(loc => filterFieldValue(loc, field)).filter(Boolean))
    return vals.size >= 2
  })

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(mainTableData, baseColumns, { initialVisibility })
  // v2 key: the column set expanded to the full Global Config schema, so old
  // saved prefs (which predate those columns) are intentionally not reused.
  useColumnPrefs('core.locations.v2', table, columnVisibility, columnOrder, setColumnOrder)

  const colLabel = (c: ReturnType<typeof table.getAllLeafColumns>[number]) =>
    typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id

  // Every manageable column (id + label) for the column manager.
  const allColItems = useMemo<ColItem[]>(
    () => table.getAllLeafColumns()
      .filter((c) => !PINNED.includes(c.id))
      .map((c) => ({ id: c.id, label: colLabel(c) })),
    [table, columnVisibility], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Ordered ids of currently-visible columns (what the table renders, left→right).
  const shownOrder = useMemo(() => {
    const visible = table.getAllLeafColumns().filter((c) => !PINNED.includes(c.id) && c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return visible
    const rank = (id: string) => { const i = columnOrder.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i }
    return [...visible].sort((a, b) => rank(a) - rank(b))
  }, [table, columnOrder, columnVisibility]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply a new shown/ordered set from the manager: order = shown then hidden,
  // visibility = explicit true/false for every column (so prefs round-trip).
  function applyShown(shown: string[]) {
    const shownSet = new Set(shown)
    const hidden = allColItems.map((c) => c.id).filter((id) => !shownSet.has(id))
    setColumnOrder([...PINNED, ...shown, ...hidden])
    const vis: VisibilityState = {}
    for (const c of allColItems) vis[c.id] = shownSet.has(c.id)
    table.setColumnVisibility(vis)
  }

  function resetToDefault() {
    setColumnOrder([])
    table.setColumnVisibility(initialVisibility)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Locations</h1>
        <p className="text-xs text-inky mt-0.5">All locations in your workspace</p>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">List</TabsTrigger>
          <TabsTrigger value="map">Map &amp; Routes</TabsTrigger>
        </TabsList>

        <TabsContent value="map">
          <MapRoutesTab locations={data} />
        </TabsContent>

        <TabsContent value="list">
      <div className="flex flex-col gap-2">
        {needsClassification.length > 0 && (
          <Card>
            <CardBody className="flex flex-col gap-2">
              <div>
                <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">
                  New Locations — Need Classification ({needsClassification.length})
                </h3>
                <p className="text-[11px] font-mono text-inky/60 mt-0.5">
                  Added in the last {CLASSIFY_WINDOW_HOURS} hours. Mark each as Oil Change or Car Wash — Car Wash
                  locations are excluded from lookup lists, inventory alerts, and order runs, and move to their own
                  group below.
                </p>
              </div>
              <div className="flex flex-col divide-y divide-navy/10">
                {needsClassification.map((l) => (
                  <div key={l.id} className="flex items-center justify-between gap-3 py-1.5">
                    <span className="text-xs font-mono text-navy">{l.shop_city || l.name}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button size="sm" variant="secondary" loading={classifying === l.id} onClick={() => classify(l.id, 'oil_change')}>
                        Oil Change
                      </Button>
                      <Button size="sm" variant="secondary" loading={classifying === l.id} onClick={() => classify(l.id, 'car_wash')}>
                        Car Wash
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        )}

        {/* Contextual filter dropdowns */}
        {!loading && visibleHierarchy.length > 0 && (
          <div className="flex items-end gap-3 flex-wrap">
            {visibleHierarchy.map(({ field, label }, fi) => {
              const hierarchyIdx = LOC_FILTER_HIERARCHY.findIndex(h => h.field === field)
              const above = rowsAbove(hierarchyIdx)
              const opts = Array.from(new Set(above.map(loc => filterFieldValue(loc, field)).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              return (
                <div key={field} className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">{label}</span>
                  <MultiSelectDropdown
                    options={opts.map(v => ({ value: v, count: above.filter(loc => filterFieldValue(loc, field) === v).length }))}
                    selected={dropFilters[field] ?? []}
                    onChange={vals => setDropFilter(field, vals, hierarchyIdx)}
                  />
                </div>
              )
            })}
            <div className="flex items-end gap-2 ml-auto pb-0.5">
              {hasActiveFilters && (
                <button
                  onClick={() => setDropFilters({})}
                  className="text-xs font-mono text-inky/60 hover:text-navy underline whitespace-nowrap"
                >
                  Clear Filters
                </button>
              )}
              <div className="relative" ref={dropSettingsRef}>
                <button
                  onClick={() => setDropSettingsOpen(o => !o)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
                >
                  Dropdowns ▾
                </button>
                {dropSettingsOpen && (
                  <div className="absolute top-full right-0 mt-1 z-30 bg-cream dark:bg-[#0e2638] border border-navy/30 rounded shadow-xl p-3 min-w-[190px] flex flex-col gap-1.5">
                    <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-1">Toggle visible dropdowns</p>
                    {LOC_FILTER_HIERARCHY.map(({ field, label }) => (
                      <label key={field} className="flex items-center gap-2 cursor-pointer text-xs font-body text-navy">
                        <input
                          type="checkbox"
                          checked={!hiddenDropdowns.has(field)}
                          onChange={e => {
                            setHiddenDropdowns(prev => {
                              const next = new Set(prev)
                              if (e.target.checked) next.delete(field)
                              else next.add(field)
                              return next
                            })
                          }}
                          className="accent-sky"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename="locations.csv"
          exportData={data}
          loading={loading}
          hideColumnControl
          actions={
            <button
              onClick={() => setColsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              Columns
            </button>
          }
        />

        <CollapsibleLocationGroup
          title="Car Wash" locations={carWashLocations} open={carWashOpen} onToggle={() => setCarWashOpen((o) => !o)}
        />
        <CollapsibleLocationGroup
          title="Closed" locations={closedLocations} open={closedOpen} onToggle={() => setClosedOpen((o) => !o)}
        />
      </div>
        </TabsContent>
      </Tabs>

      <ColumnManagerModal
        open={colsOpen}
        onClose={() => setColsOpen(false)}
        all={allColItems}
        shown={shownOrder}
        onChange={applyShown}
        onReset={resetToDefault}
      />
    </div>
  )
}

// Collapsed by default (matches the module's existing collapsed-section
// convention, e.g. Data Connections' Historical Backfill Plan card) — these
// locations don't need to be in anyone's way, just reachable. A lightweight
// list rather than a full DataTable: this is a "here's what's set aside and
// why" view, not something anyone needs to sort/filter/export the same way
// as the main table.
function CollapsibleLocationGroup({ title, locations, open, onToggle }: {
  title: string
  locations: Location[]
  open: boolean
  onToggle: () => void
}) {
  if (locations.length === 0) return null
  return (
    <div className="rounded border border-navy/20">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-mono uppercase tracking-wide text-navy hover:bg-sky/10 transition-colors"
      >
        <span>{title} ({locations.length})</span>
        <span className="text-inky/50">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="border-t border-navy/10 divide-y divide-navy/10">
          {locations.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs font-mono">
              <span className="text-navy">{l.shop_city || l.name}</span>
              <span className="text-inky/50">{l.region || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
