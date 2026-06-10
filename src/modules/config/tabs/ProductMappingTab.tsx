import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { ProductIdMapping, ColumnMapping, ParsedUpload } from '@/types'
import { useForm } from 'react-hook-form'

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
  col.accessor('created_at', { header: 'Added', cell: (i) => new Date(i.getValue()).toLocaleDateString() }),
]

export function ProductMappingTab() {
  const { data, loading, insert, upsertBatch } = useConfigTab<ProductIdMapping>('product_id_mappings')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ old_product_id: string; new_product_id: string; notes: string }>()

  async function confirmImport() {
    if (!parsed || !mappings) return
    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of mappings) out[m.fieldName] = row[m.sourceColumn] || null
      return out
    })
    await upsertBatch(rows as Partial<ProductIdMapping>[])
    setParsed(null); setMappings(null); setConfirmOpen(false)
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
          {!parsed ? <FileUploadZone onParsed={(r) => setParsed(r)} />
            : !mappings ? (
              <div className="border border-[#2a2d3e] rounded-lg p-4 bg-[#0f1117]">
                <ColumnMapper headers={parsed.headers} requiredFields={REQUIRED_FIELDS}
                  onConfirm={(m) => { setMappings(m); setConfirmOpen(true) }} onCancel={() => setParsed(null)} />
              </div>
            ) : null}
          <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import">
            <p className="text-sm text-gray-300 mb-4 font-mono">Import {parsed?.totalRowsParsed} mappings?</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>Back</Button>
              <Button size="sm" onClick={confirmImport}>Import</Button>
            </div>
          </Modal>
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
