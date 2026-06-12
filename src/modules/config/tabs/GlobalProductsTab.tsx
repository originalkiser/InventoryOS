import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { applyTransform } from '@/lib/columnTransform'
import type { GlobalProduct, ColumnMapping } from '@/types'
import { useForm } from 'react-hook-form'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'unit_of_measure', label: 'Unit of Measure' },
  { name: 'package_type', label: 'Package Type' },
  { name: 'bulk_minimum', label: 'Bulk Minimum' },
  { name: 'individual_minimum', label: 'Individual Minimum' },
]
const NUM = ['bulk_minimum', 'individual_minimum']

const col = createColumnHelper<GlobalProduct>()
const COLUMNS = [
  col.accessor('product_id', { header: 'Product ID' }),
  col.accessor('unit_of_measure', { header: 'UoM', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('package_type', { header: 'Pkg', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('bulk_minimum', { header: 'Bulk Min', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('individual_minimum', { header: 'Ind Min', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
]

export function GlobalProductsTab() {
  const { data, loading, insert, importRows } = useConfigTab<GlobalProduct>('global_products')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [addOpen, setAddOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ product_id: string; unit_of_measure: string }>()

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) {
        const v = applyTransform(row[m.sourceColumn] ?? '', m.transform)
        out[m.fieldName] = NUM.includes(m.fieldName) ? (v ? parseFloat(v.replace(/[$,]/g, '')) : null) : v || null
      }
      return out as Partial<GlobalProduct>
    }).filter((r: any) => r.product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.product_id ?? '').toLowerCase() })
    setImporting(false)
  }

  async function onAdd(form: { product_id: string; unit_of_measure: string }) {
    await insert(form); reset(); setAddOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="global_products.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={() => setAddOpen(true)}>+ Add Product</Button>}
      />
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="global_products" />
      </div>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Global Product">
        <form onSubmit={handleSubmit(onAdd)} className="flex flex-col gap-3">
          <Input label="Product ID *" {...register('product_id', { required: true })} />
          <Input label="Unit of Measure" {...register('unit_of_measure')} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit">Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
