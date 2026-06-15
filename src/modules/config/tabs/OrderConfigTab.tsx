import { useEffect, useMemo, useState, useCallback } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { LocationOrderConfig, Vendor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const NUM_FIELDS = ['capacity', 'order_trigger', 'order_limit']

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}

const col = createColumnHelper<LocationOrderConfig>()

export function OrderConfigTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { data, loading, insert, update, remove, importRows } = useConfigTab<LocationOrderConfig>('location_order_configs')
  const { active: customFields, addField } = useCustomFields('order_config')
  const loc = useLocations()

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [uploadVendorId, setUploadVendorId] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  const loadVendors = useCallback(async () => {
    if (!companyId) return
    const { data: v } = await (supabase as any).from('vendors').select('*').eq('company_id', companyId).order('name')
    setVendors((v ?? []) as Vendor[])
  }, [companyId])
  useEffect(() => { loadVendors() }, [loadVendors])

  const vendorName = (id: string | null) => vendors.find((v) => v.id === id)?.name ?? '—'
  const vendorOptions: ComboboxOption[] = vendors.map((v) => ({ value: v.id, label: v.name }))

  // Non-linked custom fields are editable/stored; linked ones derive from the location.
  const ownFields = customFields.filter((f) => !f.linked_section)
  const linkedFields = customFields.filter((f) => f.linked_section)

  const [form, setForm] = useState({ vendorId: '', locationId: '', product_id: '', uom: '', capacity: '', order_trigger: '', order_limit: '' })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'vendor', header: 'Vendor', accessorFn: (r: LocationOrderConfig) => vendorName(r.vendor_id), cell: (i: any) => i.getValue() },
      { id: 'location', header: 'Location', accessorFn: (r: LocationOrderConfig) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
      col.accessor('product_id', { header: 'Product ID' }),
      { id: 'uom', header: 'UoM', accessorFn: (r: LocationOrderConfig) => (r.metadata as any)?.uom ?? '', cell: (i: any) => i.getValue() || '—' },
      col.accessor('capacity', { header: 'Capacity', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_trigger', { header: 'Trigger', cell: (i) => i.getValue() ?? '—' }),
      col.accessor('order_limit', { header: 'Limit (0 = inactive)', cell: (i) => i.getValue() ?? '—' }),
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
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as LocationOrderConfig; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as LocationOrderConfig)} className="text-xs font-mono text-[#00e5ff] hover:underline">Edit</button> })
    return cols
  }, [customFields, loc, vendors])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  // All uploaded products are treated as active; set Order Limit to 0 to make a
  // product inactive. UoM is captured (used by UoM conversions).
  const uploadFields = [
    { name: 'location', label: 'Location', required: true },
    { name: 'product_id', label: 'Product ID', required: true },
    { name: 'uom', label: 'Unit of Measure' },
    { name: 'capacity', label: 'Capacity' },
    { name: 'order_trigger', label: 'Order Trigger' },
    { name: 'order_limit', label: 'Order Limit (0 = inactive)' },
    ...ownFields.map((f) => ({ name: f.field_key, label: f.label })),
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const ownKeys = new Set(ownFields.map((f) => f.field_key))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = { vendor_id: uploadVendorId || null, active: true }
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = mappedValue(row, m)
        if (m.fieldName === 'location') out.location_id = loc.resolveId(raw)
        else if (m.fieldName === 'uom') meta.uom = raw || null
        else if (NUM_FIELDS.includes(m.fieldName)) out[m.fieldName] = num(raw)
        else if (ownKeys.has(m.fieldName)) meta[m.fieldName] = raw || null
        else out[m.fieldName] = raw || null
      }
      out.metadata = meta
      return out as Partial<LocationOrderConfig>
    }).filter((r: any) => r.product_id)
    // Per-vendor: key by vendor + location + product so each vendor's config is
    // separate and re-uploading a vendor's file updates only its rows.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.vendor_id ?? ''}|${r.location_id ?? ''}|${r.product_id}` })
    setImporting(false)
  }

  function resetForm() { setForm({ vendorId: '', locationId: '', product_id: '', uom: '', capacity: '', order_trigger: '', order_limit: '' }); setCustomVals({}) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: LocationOrderConfig) {
    setEditId(r.id)
    setForm({
      vendorId: r.vendor_id ?? '', locationId: r.location_id ?? '', product_id: r.product_id ?? '', uom: ((r.metadata as any)?.uom ?? '') as string,
      capacity: r.capacity?.toString() ?? '', order_trigger: r.order_trigger?.toString() ?? '', order_limit: r.order_limit?.toString() ?? '',
    })
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCustomVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.locationId || !form.product_id.trim()) return
    const meta: Record<string, unknown> = {}
    for (const f of ownFields) meta[f.field_key] = customVals[f.field_key] || null
    if (form.uom.trim()) meta.uom = form.uom.trim()
    const payload = {
      vendor_id: form.vendorId || null,
      location_id: form.locationId, product_id: form.product_id.trim(),
      capacity: num(form.capacity), order_trigger: num(form.order_trigger), order_limit: num(form.order_limit),
      active: true, metadata: meta,
    } as Partial<LocationOrderConfig>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this order config row?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="order_config.csv" exportData={data} loading={loading}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
          <Button size="sm" onClick={openAdd}>+ Add Config</Button>
        </>}
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File (per vendor)</h3>
          <Combobox label="Vendor for this file" options={[{ value: '', label: '— No vendor —' }, ...vendorOptions]} value={uploadVendorId}
            onChange={(v) => setUploadVendorId(v)} placeholder="Select vendor (optional)" />
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} onAddColumn={(label) => addField({ label })} />
          <p className="text-xs font-mono text-gray-600">Tag the file with a vendor to keep each vendor's order config separate. Re-uploading a vendor's file updates only its rows.</p>
        </div>
        <DataSourceLinker configType="location_order_configs" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Order Config' : 'Add Order Config'} size="lg">
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Combobox label="Vendor" options={[{ value: '', label: '— No vendor —' }, ...vendorOptions]} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} placeholder="Optional" />
            <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Unit of Measure" value={form.uom} onChange={(e) => setForm({ ...form, uom: e.target.value })} />
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
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.locationId || !form.product_id.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Order Config Columns" size="lg">
        <CustomFieldsEditor section="order_config" linkSections={[{ value: 'locations', label: 'Locations' }]} />
      </Modal>
    </div>
  )
}
