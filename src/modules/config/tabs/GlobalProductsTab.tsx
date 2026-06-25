import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { GlobalProduct, ColumnMapping } from '@/types'
import { format } from 'date-fns'

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
const EMPTY = { product_id: '', unit_of_measure: '', order_uom: '', package_type: '', bulk_minimum: '', individual_minimum: '' }

const REQUIRED_FIELDS = [
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'unit_of_measure', label: 'Unit of Measure (on-hand)' },
  { name: 'order_uom', label: 'Order Unit' },
  { name: 'package_type', label: 'Package Type' },
  { name: 'bulk_minimum', label: 'Bulk Minimum' },
  { name: 'individual_minimum', label: 'Individual Minimum' },
]
const NUM = ['bulk_minimum', 'individual_minimum']

const col = createColumnHelper<GlobalProduct>()

export function GlobalProductsTab() {
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<GlobalProduct>('global_products')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const COLUMNS = [
    col.accessor('product_id', { header: 'Product ID' }),
    col.accessor('unit_of_measure', { header: 'On-Hand UoM', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('order_uom', { header: 'Order UoM', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('package_type', { header: 'Pkg', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('bulk_minimum', { header: 'Bulk Min', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('individual_minimum', { header: 'Ind Min', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : 'â€”' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as GlobalProduct)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ]
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: GlobalProduct) {
    setEditId(r.id)
    setForm({ product_id: r.product_id ?? '', unit_of_measure: r.unit_of_measure ?? '', order_uom: r.order_uom ?? '', package_type: r.package_type ?? '', bulk_minimum: r.bulk_minimum?.toString() ?? '', individual_minimum: r.individual_minimum?.toString() ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        out[m.fieldName] = NUM.includes(m.fieldName) ? (v ? parseFloat(v.replace(/[$,]/g, '')) : null) : v || null
      }
      return out as Partial<GlobalProduct>
    }).filter((r: any) => r.product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.product_id ?? '').toLowerCase() })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.product_id.trim()) return
    const payload = {
      product_id: form.product_id.trim(), unit_of_measure: form.unit_of_measure.trim() || null,
      order_uom: form.order_uom.trim() || null,
      package_type: form.package_type.trim() || null, bulk_minimum: num(form.bulk_minimum), individual_minimum: num(form.individual_minimum),
    } as Partial<GlobalProduct>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm(`Delete product "${form.product_id}"?`)) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="global_products.csv" exportData={data} loading={loading}
        actions={<><ClearTableButton clearAll={clearAll} /><Button size="sm" onClick={openAdd}>+ Add Product</Button></>}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="global_products" />
      </div>
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Global Product' : 'Add Global Product'}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="On-Hand Unit" value={form.unit_of_measure} onChange={(e) => setForm({ ...form, unit_of_measure: e.target.value })} />
            <Input label="Order Unit" value={form.order_uom} onChange={(e) => setForm({ ...form, order_uom: e.target.value })} />
            <Input label="Package Type" value={form.package_type} onChange={(e) => setForm({ ...form, package_type: e.target.value })} />
            <Input label="Bulk Minimum" value={form.bulk_minimum} onChange={(e) => setForm({ ...form, bulk_minimum: e.target.value })} />
            <Input label="Individual Minimum" value={form.individual_minimum} onChange={(e) => setForm({ ...form, individual_minimum: e.target.value })} />
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.product_id.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
