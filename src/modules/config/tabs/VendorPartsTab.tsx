import { useEffect, useMemo, useState, useCallback } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import type { ComboboxOption } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { VendorPart, Vendor, ColumnMapping } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const NUM_FIELDS = ['bulk_minimum', 'individual_minimum']

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}
function slugCode(name: string) {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'VENDOR'
}

const col = createColumnHelper<VendorPart>()

export function VendorPartsTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<VendorPart>('vendor_parts', 'core')
  const { active: customFields, addField } = useCustomFields('vendor_parts')

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [uploadVendorId, setUploadVendorId] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  const [form, setForm] = useState({ vendorId: '', part_number: '', our_part_number: '', description: '', unit_of_measure: '', package_type: '', bulk_minimum: '', individual_minimum: '' })
  const [customVals, setCustomVals] = useState<Record<string, string>>({})

  const loadVendors = useCallback(async () => {
    if (!companyId) return
    const { data: v } = await (supabase as any).schema('core').from('vendors').select('*').eq('company_id', companyId).order('name')
    setVendors((v ?? []) as Vendor[])
  }, [companyId])
  useEffect(() => { loadVendors() }, [loadVendors])

  const vendorName = (id: string | null) => vendors.find((v) => v.id === id)?.name ?? 'â€”'
  const vendorOptions: ComboboxOption[] = vendors.map((v) => ({ value: v.id, label: v.name }))

  async function createVendor(name: string): Promise<ComboboxOption> {
    const { data: v, error } = await (supabase as any).schema('core').from('vendors').insert({ company_id: companyId, name: name.trim(), vendor_code: slugCode(name) }).select().single()
    if (error) { toast.error(error.message); throw error }
    await loadVendors()
    toast.success(`Vendor "${name.trim()}" added`)
    return { value: v.id, label: v.name }
  }

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'vendor', header: 'Vendor', accessorFn: (r: VendorPart) => vendorName(r.vendor_id), cell: (i: any) => i.getValue() },
      col.accessor('part_number', { header: 'Vendor Part #' }),
      col.accessor('our_part_number', { header: 'Our Part #', cell: (i) => i.getValue() ?? 'â€”' }),
      col.accessor('description', { header: 'Description', cell: (i) => i.getValue() ?? 'â€”' }),
      col.accessor('unit_of_measure', { header: 'UoM', cell: (i) => i.getValue() ?? 'â€”' }),
      col.accessor('package_type', { header: 'Pkg', cell: (i) => i.getValue() ?? 'â€”' }),
      col.accessor('bulk_minimum', { header: 'Bulk Min', cell: (i) => i.getValue() ?? 'â€”' }),
      col.accessor('individual_minimum', { header: 'Ind Min', cell: (i) => i.getValue() ?? 'â€”' }),
    ]
    for (const f of customFields) cols.push({ id: `cf_${f.field_key}`, header: f.label, accessorFn: (r: VendorPart) => (r.metadata as any)?.[f.field_key] ?? '', cell: (i: any) => i.getValue() || 'â€”' })
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : 'â€”' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as VendorPart)} className="text-xs font-mono text-inky hover:underline">Edit</button> })
    return cols
  }, [customFields, vendors])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  const uploadFields = [
    { name: 'part_number', label: 'Vendor Part #', required: true },
    { name: 'our_part_number', label: 'Our Part #' },
    { name: 'description', label: 'Description' },
    { name: 'unit_of_measure', label: 'Unit of Measure' },
    { name: 'package_type', label: 'Package Type' },
    { name: 'bulk_minimum', label: 'Bulk Minimum' },
    { name: 'individual_minimum', label: 'Individual Minimum' },
    ...customFields.map((f) => ({ name: f.field_key, label: f.label })),
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    if (!uploadVendorId) { toast.error('Select the vendor for this file first'); return }
    setImporting(true)
    const customKeys = new Set(customFields.map((f) => f.field_key))
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = { vendor_id: uploadVendorId }
      const meta: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = mappedValue(row, m)
        if (NUM_FIELDS.includes(m.fieldName)) out[m.fieldName] = num(raw)
        else if (customKeys.has(m.fieldName)) meta[m.fieldName] = raw || null
        else out[m.fieldName] = raw || null
      }
      out.metadata = meta
      return out as Partial<VendorPart>
    }).filter((r: any) => r.part_number)
    // Per-vendor stacking: match on vendor + part number, so re-uploading a
    // vendor's file updates its parts and leaves other vendors untouched.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.vendor_id ?? ''}|${r.part_number}` })
    setImporting(false)
  }

  function resetForm() {
    setForm({ vendorId: '', part_number: '', our_part_number: '', description: '', unit_of_measure: '', package_type: '', bulk_minimum: '', individual_minimum: '' })
    setCustomVals({})
  }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: VendorPart) {
    setEditId(r.id)
    setForm({
      vendorId: r.vendor_id ?? '', part_number: r.part_number ?? '', our_part_number: r.our_part_number ?? '',
      description: r.description ?? '', unit_of_measure: r.unit_of_measure ?? '', package_type: r.package_type ?? '',
      bulk_minimum: r.bulk_minimum?.toString() ?? '', individual_minimum: r.individual_minimum?.toString() ?? '',
    })
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCustomVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.part_number.trim()) { toast.error('Vendor Part # is required'); return }
    const meta: Record<string, unknown> = {}
    for (const f of customFields) meta[f.field_key] = customVals[f.field_key] || null
    const payload = {
      vendor_id: form.vendorId || null,
      part_number: form.part_number.trim(),
      our_part_number: form.our_part_number.trim() || null,
      description: form.description.trim() || null,
      unit_of_measure: form.unit_of_measure.trim() || null,
      package_type: form.package_type.trim() || null,
      bulk_minimum: num(form.bulk_minimum),
      individual_minimum: num(form.individual_minimum),
      metadata: meta,
    } as Partial<VendorPart>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm(`Delete part "${form.part_number}"?`)) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="vendor_parts.csv" exportData={data} loading={loading}
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Columns</Button>
          <Button size="sm" onClick={openAdd}>+ Add Part</Button>
        </>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File (per vendor)</h3>
          <Combobox label="Vendor for this file *" options={vendorOptions} value={uploadVendorId}
            onChange={(v) => setUploadVendorId(v)} placeholder="Select or create vendor"
            allowCreate onCreateOption={createVendor} />
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} onAddColumn={(label) => addField({ label })} />
          <p className="text-xs font-mono text-inky/70">Upload one file per vendor â€” each can map differently. Re-uploading a vendor's file updates its parts; other vendors are untouched.</p>
        </div>
        <DataSourceLinker configType="vendor_parts" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Vendor Part' : 'Add Vendor Part'} size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Vendor" options={vendorOptions} value={form.vendorId} onChange={(v) => setForm({ ...form, vendorId: v })} placeholder="Select or create vendor" allowCreate onCreateOption={createVendor} />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Vendor Part # *" value={form.part_number} onChange={(e) => setForm({ ...form, part_number: e.target.value })} />
            <Input label="Our Part #" value={form.our_part_number} onChange={(e) => setForm({ ...form, our_part_number: e.target.value })} />
            <Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <Input label="Unit of Measure" value={form.unit_of_measure} onChange={(e) => setForm({ ...form, unit_of_measure: e.target.value })} />
            <Input label="Package Type" value={form.package_type} onChange={(e) => setForm({ ...form, package_type: e.target.value })} />
            <Input label="Bulk Minimum" value={form.bulk_minimum} onChange={(e) => setForm({ ...form, bulk_minimum: e.target.value })} />
            <Input label="Individual Minimum" value={form.individual_minimum} onChange={(e) => setForm({ ...form, individual_minimum: e.target.value })} />
            {customFields.map((f) => (
              <Input key={f.id} label={f.label} value={customVals[f.field_key] ?? ''} onChange={(e) => setCustomVals({ ...customVals, [f.field_key]: e.target.value })} />
            ))}
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.part_number.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Vendor Part Columns" size="lg">
        <CustomFieldsEditor section="vendor_parts" />
      </Modal>
    </div>
  )
}
