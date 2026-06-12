import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { applyTransform } from '@/lib/columnTransform'
import type { Location, ColumnMapping } from '@/types'
import { format } from 'date-fns'

// Code / Name / Region are real columns; the rest are recommended custom columns.
const RECOMMENDED = [
  { label: 'Market' },
  { label: 'Area Manager' },
  { label: 'Regional Director' },
  { label: 'Delivery Day' },
  { label: 'Location Phone' },
  { label: 'Area Manager Phone' },
  { label: 'Regional Director Phone' },
]

const BASE_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'name', label: 'Name', required: true },
  { name: 'region', label: 'Region' },
  { name: 'active', label: 'Active (bool)' },
]

function coerce(value: string, type: string): unknown {
  const v = value.trim()
  if (v === '') return null
  if (type === 'number') { const n = Number(v.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
  return v
}

const col = createColumnHelper<Location>()

export function LocationsTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, importRows } = useConfigTab<Location>('locations')
  const { active: customFields } = useCustomFields('locations')

  const [addOpen, setAddOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  // Add-form state: base + dynamic custom values
  const [base, setBase] = useState({ location_code: '', name: '', region: '' })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      col.accessor('location_code', { header: 'Code' }),
      col.accessor('name', { header: 'Name' }),
      col.accessor('region', { header: 'Region', cell: (i) => i.getValue() ?? '—' }),
    ]
    for (const f of customFields) {
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
    return cols
  }, [customFields])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function buildMetadata(values: Record<string, string>) {
    const meta: Record<string, unknown> = {}
    for (const f of customFields) meta[f.field_key] = coerce(values[f.field_key] ?? '', f.field_type)
    return meta
  }

  async function onAddSubmit() {
    if (!base.location_code.trim() || !base.name.trim()) return
    await insert({
      location_code: base.location_code.trim(),
      name: base.name.trim(),
      region: base.region.trim() || null,
      metadata: buildMetadata(customVals),
      updated_by: profile?.id ?? null,
      last_change_source: 'manual',
    } as Partial<Location>)
    setBase({ location_code: '', name: '', region: '' })
    setCustomVals({})
    setAddOpen(false)
  }

  async function confirmImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const customKeys = new Set(customFields.map((f) => f.field_key))
    const typeByKey = new Map(customFields.map((f) => [f.field_key, f.field_type]))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = applyTransform(row[m.sourceColumn] ?? '', m.transform)
        if (m.fieldName === 'active') out.active = ['true', '1', 'yes'].includes(raw.toLowerCase())
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
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="locations.csv"
        exportData={data}
        loading={loading}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>+ Add Location</Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={confirmImport} importing={importing} />
        </div>

        <DataSourceLinker configType="locations" />
      </div>

      {/* Add location */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Location" size="lg">
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
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={onAddSubmit} disabled={!base.location_code.trim() || !base.name.trim()}>Save</Button>
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
