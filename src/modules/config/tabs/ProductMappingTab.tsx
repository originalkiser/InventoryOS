import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ProductIdMapping, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'old_product_id', label: 'Old Product ID', required: true },
  { name: 'new_product_id', label: 'New Product ID', required: true },
  { name: 'notes', label: 'Notes' },
]

const col = createColumnHelper<ProductIdMapping>()
const EMPTY = { old_product_id: '', new_product_id: '', notes: '' }

export function ProductMappingTab() {
  const { data, loading, insert, update, remove, importRows } = useConfigTab<ProductIdMapping>('product_id_mappings')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const COLUMNS = [
    col.accessor('old_product_id', { header: 'Old ID' }),
    col.accessor('new_product_id', { header: 'New ID' }),
    col.accessor('notes', { header: 'Notes', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as ProductIdMapping)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ]
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: ProductIdMapping) {
    setEditId(r.id)
    setForm({ old_product_id: r.old_product_id ?? '', new_product_id: r.new_product_id ?? '', notes: r.notes ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) out[m.fieldName] = mappedValue(row, m) || null
      return out as Partial<ProductIdMapping>
    }).filter((r: any) => r.old_product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.old_product_id ?? '').toLowerCase() })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.old_product_id.trim() || !form.new_product_id.trim()) return
    const payload = { old_product_id: form.old_product_id.trim(), new_product_id: form.new_product_id.trim(), notes: form.notes.trim() || null } as Partial<ProductIdMapping>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this mapping?')) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="product_mappings.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={openAdd}>+ Add Mapping</Button>}
      />
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="product_id_mappings" />
      </div>
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Product Mapping' : 'Add Product Mapping'}>
        <div className="flex flex-col gap-3">
          <Input label="Old Product ID *" value={form.old_product_id} onChange={(e) => setForm({ ...form, old_product_id: e.target.value })} />
          <Input label="New Product ID *" value={form.new_product_id} onChange={(e) => setForm({ ...form, new_product_id: e.target.value })} />
          <Input label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.old_product_id.trim() || !form.new_product_id.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
