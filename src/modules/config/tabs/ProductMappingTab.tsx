import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { applyTransform } from '@/lib/columnTransform'
import type { ProductIdMapping, ColumnMapping } from '@/types'
import { useForm } from 'react-hook-form'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'old_product_id', label: 'Old Product ID', required: true },
  { name: 'new_product_id', label: 'New Product ID', required: true },
  { name: 'notes', label: 'Notes' },
]

const col = createColumnHelper<ProductIdMapping>()
const COLUMNS = [
  col.accessor('old_product_id', { header: 'Old ID' }),
  col.accessor('new_product_id', { header: 'New ID' }),
  col.accessor('notes', { header: 'Notes', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
]

export function ProductMappingTab() {
  const { data, loading, insert, importRows } = useConfigTab<ProductIdMapping>('product_id_mappings')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [addOpen, setAddOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ old_product_id: string; new_product_id: string; notes: string }>()

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) out[m.fieldName] = applyTransform(row[m.sourceColumn] ?? '', m.transform) || null
      return out as Partial<ProductIdMapping>
    }).filter((r: any) => r.old_product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.old_product_id ?? '').toLowerCase() })
    setImporting(false)
  }

  async function onAdd(form: { old_product_id: string; new_product_id: string; notes: string }) {
    await insert(form); reset(); setAddOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="product_mappings.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={() => setAddOpen(true)}>+ Add Mapping</Button>}
      />
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="product_id_mappings" />
      </div>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Product Mapping">
        <form onSubmit={handleSubmit(onAdd)} className="flex flex-col gap-3">
          <Input label="Old Product ID *" {...register('old_product_id', { required: true })} />
          <Input label="New Product ID *" {...register('new_product_id', { required: true })} />
          <Input label="Notes" {...register('notes')} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit">Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
