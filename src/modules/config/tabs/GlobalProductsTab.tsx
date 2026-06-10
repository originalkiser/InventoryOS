import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { GlobalProduct, ColumnMapping, ParsedUpload } from '@/types'
import { useForm } from 'react-hook-form'

const REQUIRED_FIELDS = [
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'unit_of_measure', label: 'Unit of Measure' },
  { name: 'package_type', label: 'Package Type' },
  { name: 'bulk_minimum', label: 'Bulk Minimum' },
  { name: 'individual_minimum', label: 'Individual Minimum' },
]

const col = createColumnHelper<GlobalProduct>()
const COLUMNS = [
  col.accessor('product_id', { header: 'Product ID' }),
  col.accessor('unit_of_measure', { header: 'UoM', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('package_type', { header: 'Pkg', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('bulk_minimum', { header: 'Bulk Min', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('individual_minimum', { header: 'Ind Min', cell: (i) => i.getValue() ?? '—' }),
]

export function GlobalProductsTab() {
  const { data, loading, insert, upsertBatch } = useConfigTab<GlobalProduct>('global_products')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ product_id: string; unit_of_measure: string }>()

  async function confirmImport() {
    if (!parsed || !mappings) return
    const NUM = ['bulk_minimum', 'individual_minimum']
    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of mappings) {
        const v = row[m.sourceColumn] ?? ''
        out[m.fieldName] = NUM.includes(m.fieldName) ? (v ? parseFloat(v) : null) : v || null
      }
      return out
    })
    await upsertBatch(rows as Partial<GlobalProduct>[])
    setParsed(null); setMappings(null); setConfirmOpen(false)
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
          {!parsed ? <FileUploadZone onParsed={(r) => setParsed(r)} />
            : !mappings ? (
              <div className="border border-[#2a2d3e] rounded-lg p-4 bg-[#0f1117]">
                <ColumnMapper headers={parsed.headers} requiredFields={REQUIRED_FIELDS}
                  onConfirm={(m) => { setMappings(m); setConfirmOpen(true) }} onCancel={() => setParsed(null)} />
              </div>
            ) : null}
          <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import">
            <p className="text-sm text-gray-300 mb-4 font-mono">Import {parsed?.totalRowsParsed} products?</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>Back</Button>
              <Button size="sm" onClick={confirmImport}>Import</Button>
            </div>
          </Modal>
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
