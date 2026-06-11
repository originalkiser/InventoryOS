import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { LocationOrderConfig, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const NUM_FIELDS = ['capacity', 'order_trigger', 'order_limit']

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}

const col = createColumnHelper<LocationOrderConfig>()

export function OrderConfigTab() {
  const { data, loading, insert, importRows } = useConfigTab<LocationOrderConfig>('location_order_configs')
  const { active: customFields } = useCustomFields('order_config')
  const loc = useLocations()

  const [addOpen, setAddOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  // Non-linked custom fields are editable/stored; linked ones derive from the location.
  const ownFields = customFields.filter((f) => !f.linked_section)
  const linkedFields = customFields.filter((f) => f.linked_section)

  const [form, setForm] = useState({ locationId: '', product_id: '', capacity: '', order_trigger: '', order_limit: '' })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'location', header: 'Location', accessorFn: (r: LocationOrderConfig) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
      col.accessor('product_id', { header: 'Product ID' }),
      col.accessor('capacity', { header: 'Capacity', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_trigger', { header: 'Trigger', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_limit', { header: 'Limit', cell: (i) => i.getValue() ?? '—' }),
    ]
    for (const f of customFields) {
      cols.push({
        id: `cf_${f.field_key}`,
        header: f.linked_section ? `${f.label} ↗` : f.label,
        accessorFn: (r: LocationOrderConfig) =>
          f.linked_section ? loc.fieldValue(r.location_id, f.linked_match_key || f.field_key) : ((r.metadata as any)?.[f.field_key] ?? ''),
        cell: (i: any) => i.getValue() || '—',
      })
    }
    cols.push(col.accessor('active', { header: 'Active', cell: (i) => (i.getValue() ? '✓' : '✗') }))
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as LocationOrderConfig; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }))
    return cols
  }, [customFields, loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  const uploadFields = [
    { name: 'location', label: 'Location', required: true },
    { name: 'product_id', label: 'Product ID', required: true },
    { name: 'capacity', label: 'Capacity' },
    { name: 'order_trigger', label: 'Order Trigger' },
    { name: 'order_limit', label: 'Order Limit' },
    { name: 'active', label: 'Active' },
    ...ownFields.map((f) => ({ name: f.field_key, label: f.label })),
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const ownKeys = new Set(ownFields.map((f) => f.field_key))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = row[m.sourceColumn] ?? ''
        if (m.fieldName === 'location') out.location_id = loc.resolveId(raw)
        else if (m.fieldName === 'active') out.active = ['true', '1', 'yes'].includes(raw.toLowerCase())
        else if (NUM_FIELDS.includes(m.fieldName)) out[m.fieldName] = num(raw)
        else if (ownKeys.has(m.fieldName)) meta[m.fieldName] = raw || null
        else out[m.fieldName] = raw || null
      }
      out.metadata = meta
      return out as Partial<LocationOrderConfig>
    }).filter((r: any) => r.product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.product_id}` })
    setImporting(false)
  }

  async function onAdd() {
    if (!form.locationId || !form.product_id.trim()) return
    const meta: Record<string, unknown> = {}
    for (const f of ownFields) meta[f.field_key] = customVals[f.field_key] || null
    await insert({
      location_id: form.locationId, product_id: form.product_id.trim(),
      capacity: num(form.capacity), order_trigger: num(form.order_trigger), order_limit: num(form.order_limit),
      active: true, metadata: meta,
    } as Partial<LocationOrderConfig>)
    setForm({ locationId: '', product_id: '', capacity: '', order_trigger: '', order_limit: '' }); setCustomVals({}); setAddOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="order_config.csv" exportData={data} loading={loading}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>+ Add Config</Button>
        </>}
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="location_order_configs" />
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Order Config" size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Capacity" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            <Input label="Order Trigger" value={form.order_trigger} onChange={(e) => setForm({ ...form, order_trigger: e.target.value })} />
            <Input label="Order Limit" value={form.order_limit} onChange={(e) => setForm({ ...form, order_limit: e.target.value })} />
            {ownFields.map((f) => (
              <Input key={f.id} label={f.label} value={customVals[f.field_key] ?? ''} onChange={(e) => setCustomVals({ ...customVals, [f.field_key]: e.target.value })} />
            ))}
          </div>
          {linkedFields.length > 0 && (
            <p className="text-xs font-mono text-gray-600">Linked columns ({linkedFields.map((f) => f.label).join(', ')}) are pulled from the selected location automatically.</p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={onAdd} disabled={!form.locationId || !form.product_id.trim()}>Save</Button>
          </div>
        </div>
      </Modal>

      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Order Config Columns" size="lg">
        <CustomFieldsEditor section="order_config" linkSections={[{ value: 'locations', label: 'Locations' }]} />
      </Modal>
    </div>
  )
}
