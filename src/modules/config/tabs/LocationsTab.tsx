import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { LocationDataSourceConfig } from '@/modules/locations/LocationDataSourceConfig'
import { createColumnHelper, type SortingFn } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { Location, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const numericSort: SortingFn<Location> = (a, b, colId) => {
  const av = parseInt(String(a.getValue(colId) ?? ''), 10)
  const bv = parseInt(String(b.getValue(colId) ?? ''), 10)
  if (!isNaN(av) && !isNaN(bv)) return av - bv
  return String(a.getValue(colId)).localeCompare(String(b.getValue(colId)))
}

// Code / Name / Region are real columns; the rest are recommended custom columns.
const RECOMMENDED = [
  { label: 'Owner' },
  { label: 'Market' },
  { label: 'Area Manager' },
  { label: 'Regional Director' },
  { label: 'Delivery Day' },
  { label: 'Location Phone' },
  { label: 'Area Manager Phone' },
  { label: 'Regional Director Phone' },
]

// Contextual filter hierarchy for the locations quick-access table
const LOC_FILTER_HIERARCHY = [
  { field: 'meta:owner',               label: 'Owner' },
  { field: 'region',                   label: 'Region' },
  { field: 'meta:market',              label: 'Market' },
  { field: 'meta:area_manager',        label: 'Area Manager' },
  { field: 'meta:regional_director',   label: 'Regional Director' },
]
const LS_DROP_FILTERS = 'locations.tab.dropFilters'
const LS_HIDDEN_DROPS = 'locations.tab.hiddenDropdowns'

function locFieldValue(loc: any, field: string): string {
  if (field.startsWith('meta:')) return String((loc.metadata ?? {})[field.slice(5)] ?? '')
  return String((loc as any)[field] ?? '')
}

const BASE_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'name', label: 'Name', required: true },
  { name: 'region', label: 'Region' },
  { name: 'active', label: 'Active Status (text)' },
]

// Text-based active check: "Active" (case-insensitive) — and a few common
// affirmatives for backward-compatible files — count as active; any other text
// ("Inactive", "Closed", etc.) marks the location inactive. Blank keeps the
// default (active) rather than deactivating on a missing value.
function isActiveText(raw: string): boolean {
  const v = raw.trim().toLowerCase()
  if (v === '') return true
  return ['active', 'true', 'yes', 'y', '1', 'open'].includes(v)
}

function coerce(value: string, type: string): unknown {
  const v = value.trim()
  if (v === '') return null
  if (type === 'number') { const n = Number(v.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
  return v
}

const col = createColumnHelper<Location>()

export function LocationsTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<Location>('locations', 'core')
  const { active: customFields, addField } = useCustomFields('locations')

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  // Contextual dropdown filter state
  const [dropFilters, setDropFilters] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(LS_DROP_FILTERS) ?? '{}') } catch { return {} }
  })
  const [hiddenDropdowns, setHiddenDropdowns] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(LS_HIDDEN_DROPS) ?? '[]')) } catch { return new Set() }
  })
  const [dropSettingsOpen, setDropSettingsOpen] = useState(false)
  const dropSettingsRef = useRef<HTMLDivElement>(null)

  // Persist dropdown filter state
  useEffect(() => { localStorage.setItem(LS_DROP_FILTERS, JSON.stringify(dropFilters)) }, [dropFilters])
  useEffect(() => { localStorage.setItem(LS_HIDDEN_DROPS, JSON.stringify([...hiddenDropdowns])) }, [hiddenDropdowns])

  // Close settings popover on outside click
  useEffect(() => {
    if (!dropSettingsOpen) return
    function onOut(e: MouseEvent) {
      if (dropSettingsRef.current && !dropSettingsRef.current.contains(e.target as Node)) setDropSettingsOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [dropSettingsOpen])

  // Add/Edit-form state: base + dynamic custom values
  const [base, setBase] = useState({ location_code: '', name: '', region: '' })
  const [active, setActive] = useState(true)
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const openAdd = useCallback(() => {
    setEditId(null)
    setBase({ location_code: '', name: '', region: '' })
    setActive(true)
    setCustomVals({})
    setAddOpen(true)
  }, [])

  const openEdit = useCallback((r: Location) => {
    setEditId(r.id)
    setBase({ location_code: r.location_code, name: r.name, region: r.region ?? '' })
    setActive(r.active)
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCustomVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setAddOpen(true)
  }, [])

  const columns = useMemo(() => {
    const cols: any[] = [
      col.accessor('location_code', { header: 'Code', sortingFn: numericSort }),
      col.accessor('name', { header: 'Name' }),
      col.accessor('region', { header: 'Region', cell: (i) => i.getValue() ?? '—' }),
    ]
    for (const f of customFields) {
      if (['region', 'name', 'location_code'].includes(f.field_key)) continue
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.label,
        accessorFn: (r: Location) => (r.metadata as any)?.[f.field_key] ?? '',
        cell: (i: any) => i.getValue() || '—',
      })
    }
    cols.push(col.accessor('active', { header: 'Active', cell: (i) => (i.getValue() ? '✓' : '✗') }))
    cols.push(col.accessor('updated_at', {
      header: 'Last Updated',
      cell: (i) => {
        const r = i.row.original as Location
        const src = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${src}` : '—'
      },
    }))
    cols.push({
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => (
        <button onClick={() => openEdit(i.row.original as Location)} className="text-xs font-mono text-inky hover:underline">Edit</button>
      ),
    })
    return cols
  }, [customFields, openEdit])

  // Rows passing all filters ABOVE a given hierarchy index (for computing per-dropdown option counts)
  function rowsAbove(fi: number): Location[] {
    let r = data
    for (let i = 0; i < fi; i++) {
      const val = dropFilters[LOC_FILTER_HIERARCHY[i].field]
      if (val) r = r.filter(loc => locFieldValue(loc, LOC_FILTER_HIERARCHY[i].field) === val)
    }
    return r
  }

  // Filter data before passing to useTable so all TanStack features (search, sort, pagination) work on the subset
  const filteredData = useMemo(() => {
    let r = data
    for (const { field } of LOC_FILTER_HIERARCHY) {
      const val = dropFilters[field]
      if (val) r = r.filter(loc => locFieldValue(loc, field) === val)
    }
    return r
  }, [data, dropFilters])

  function setDropFilter(field: string, val: string, fi: number) {
    setDropFilters(prev => {
      const next: Record<string, string> = {}
      for (let i = 0; i < fi; i++) next[LOC_FILTER_HIERARCHY[i].field] = prev[LOC_FILTER_HIERARCHY[i].field] ?? ''
      next[field] = val
      return next
    })
  }

  const hasActiveFilters = LOC_FILTER_HIERARCHY.some(({ field }) => dropFilters[field])

  // Only show dropdowns for fields that have at least 2 distinct values in the data
  const visibleHierarchy = LOC_FILTER_HIERARCHY.filter(({ field }) => {
    if (hiddenDropdowns.has(field)) return false
    const vals = new Set(data.map(loc => locFieldValue(loc, field)).filter(Boolean))
    return vals.size >= 2
  })

  const { table, globalFilter, setGlobalFilter } = useTable(filteredData, columns, {
    initialSorting: [{ id: 'location_code', desc: false }],
  })

  function buildMetadata(values: Record<string, string>) {
    const meta: Record<string, unknown> = {}
    for (const f of customFields) meta[f.field_key] = coerce(values[f.field_key] ?? '', f.field_type)
    return meta
  }

  async function onSubmit() {
    if (!base.location_code.trim() || !base.name.trim()) return
    const payload = {
      location_code: base.location_code.trim(),
      name: base.name.trim(),
      region: base.region.trim() || null,
      active,
      metadata: buildMetadata(customVals),
    } as Partial<Location>
    if (editId) await update(editId, payload)
    else await insert({ ...payload, updated_by: profile?.id ?? null, last_change_source: 'manual' } as Partial<Location>)
    setAddOpen(false)
    setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm(`Delete location "${base.name}"? This cannot be undone.`)) return
    await remove(editId)
    setAddOpen(false)
    setEditId(null)
  }

  async function confirmImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const customKeys = new Set(customFields.map((f) => f.field_key))
    const typeByKey = new Map(customFields.map((f) => [f.field_key, f.field_type]))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'active') out.active = isActiveText(raw)
        else if (customKeys.has(m.fieldName)) meta[m.fieldName] = coerce(raw, typeByKey.get(m.fieldName) ?? 'text')
        else out[m.fieldName] = raw
      }
      out.metadata = meta
      return out as Partial<Location>
    }).filter((r: any) => r.location_code)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.location_code ?? '').toLowerCase() })
    setImporting(false)
  }

  const uploadFields = [...BASE_FIELDS, ...customFields.map((f) => ({ name: f.field_key, label: f.label }))]

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {/* Contextual filter dropdowns */}
        {!loading && visibleHierarchy.length > 0 && (
          <div className="flex items-end gap-3 flex-wrap">
            {visibleHierarchy.map(({ field, label }, fi) => {
              const hierarchyIdx = LOC_FILTER_HIERARCHY.findIndex(h => h.field === field)
              const above = rowsAbove(hierarchyIdx)
              const opts = Array.from(new Set(above.map(loc => locFieldValue(loc, field)).filter(Boolean))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
              const countFor = (v: string) => above.filter(loc => locFieldValue(loc, field) === v).length
              return (
                <div key={field} className="flex flex-col gap-0.5 min-w-[120px]">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">{label}</span>
                  <select
                    value={dropFilters[field] ?? ''}
                    onChange={e => setDropFilter(field, e.target.value, hierarchyIdx)}
                    className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none max-w-[160px]"
                  >
                    <option value="">All</option>
                    {opts.map(v => <option key={v} value={v}>{v} ({countFor(v)})</option>)}
                  </select>
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
                <Button size="sm" variant="secondary" onClick={() => setDropSettingsOpen(o => !o)}>
                  Dropdowns ▾
                </Button>
                {dropSettingsOpen && (
                  <div className="absolute top-full right-0 mt-1 z-30 bg-cream dark:bg-[#0e2638] border border-navy/30 rounded shadow-xl p-3 min-w-[190px] flex flex-col gap-1.5">
                    <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Toggle visible dropdowns</p>
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
          actions={
            <>
              <ClearTableButton clearAll={clearAll} />
              <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
              <Button size="sm" onClick={openAdd}>+ Add Location</Button>
            </>
          }
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={confirmImport} importing={importing} onAddColumn={(label) => addField({ label })} storageKey="locations" />
        </div>

        <DataSourceLinker configType="locations" />
      </div>

      <div className="border-t border-navy/10 pt-4">
        <LocationDataSourceConfig />
      </div>

      {/* Add / Edit location */}
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Location' : 'Add Location'} size="lg">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Location Code *" value={base.location_code} onChange={(e) => setBase({ ...base, location_code: e.target.value })} />
            <Input label="Name *" value={base.name} onChange={(e) => setBase({ ...base, name: e.target.value })} />
            <Input label="Region" value={base.region} onChange={(e) => setBase({ ...base, region: e.target.value })} />
            {customFields.map((f) => (
              <Input key={f.id} label={f.label}
                type={f.field_type === 'date' ? 'date' : 'text'}
                value={customVals[f.field_key] ?? ''}
                onChange={(e) => setCustomVals({ ...customVals, [f.field_key]: e.target.value })} />
            ))}
          </div>
          <Toggle checked={active} onChange={setActive} label="Active location" color="green" />
          <div className="flex justify-between gap-2 pt-2">
            <div>
              {editId && <Button variant="danger" size="sm" type="button" onClick={onDelete}>Delete</Button>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!base.location_code.trim() || !base.name.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Manage columns */}
      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Location Columns" size="lg">
        <CustomFieldsEditor section="locations" recommended={RECOMMENDED} />
      </Modal>
    </div>
  )
}
