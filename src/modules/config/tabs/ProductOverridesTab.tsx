import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ColumnMapping } from '@/types'
import { format } from 'date-fns'

interface ProductExpectation {
  id: string
  company_id: string
  product_id: string
  expected_limit: number | null
  note: string | null
  metadata: Record<string, unknown> | null
  updated_at: string
  last_change_source: string | null
}

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}
const show = (v: number | null) => (v == null ? '—' : v.toLocaleString())

const col = createColumnHelper<ProductExpectation>()

const EMPTY_FORM = { product_id: '', expected_limit: '', note: '' }

export function ProductOverridesTab() {
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } =
    useConfigTab<ProductExpectation>('product_expectations', 'inventory')

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY_FORM })

  const columns = useMemo(() => [
    col.accessor('product_id', { header: 'Product ID', cell: (i) => i.getValue() }),
    col.accessor('expected_limit', { header: 'Ceiling', cell: (i) => show(i.getValue()) }),
    col.accessor('note', { header: 'Note', cell: (i) => i.getValue() || <span className="text-inky/50">—</span> }),
    col.accessor('updated_at', {
      header: 'Last Updated',
      cell: (i) => {
        const r = i.row.original as ProductExpectation
        const s = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—'
      },
    }),
    {
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => <button onClick={() => openEdit(i.row.original as ProductExpectation)} className="text-xs font-mono text-inky hover:underline">Edit</button>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, { persistKey: 'config:product-overrides' })

  const uploadFields = [
    { name: 'product_id', label: 'Product ID', required: true },
    { name: 'expected_limit', label: 'Ceiling', required: true },
    { name: 'note', label: 'Note' },
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const r: Record<string, unknown> = {}
      let product_id = ''
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'product_id') product_id = raw.trim()
        else if (m.fieldName === 'expected_limit') r.expected_limit = num(raw)
        else if (m.fieldName === 'note') r.note = raw.trim() || null
      }
      return { product_id, expected_limit: (r.expected_limit ?? null) as number | null, note: (r.note ?? null) as string | null } as Partial<ProductExpectation>
    }).filter((r) => r.product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => (r.product_id ?? '').trim().toLowerCase() })
    setImporting(false)
  }

  function resetForm() { setForm({ ...EMPTY_FORM }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: ProductExpectation) {
    setEditId(r.id)
    setForm({
      product_id: r.product_id ?? '',
      expected_limit: r.expected_limit?.toString() ?? '',
      note: r.note ?? '',
    })
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.product_id.trim()) return
    const payload = {
      product_id: form.product_id.trim(),
      expected_limit: num(form.expected_limit),
      note: form.note.trim() || null,
    } as Partial<ProductExpectation>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this product override?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Expected On Hand — Product Overrides</h2>
        <p className="text-xs text-inky mt-0.5">
          A flat on-hand ceiling for one specific product, used instead of its category's CPD/case-type limit.
          For products whose counted unit doesn't match what the category expects (e.g. an item counted in ounces
          inside a category calibrated for cases). Takes precedence over category limits and the unlisted-category default.
        </p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="product_overrides.csv" exportData={data} loading={loading}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<>
          <Button size="sm" onClick={openAdd}>+ Add Product Override</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload Overrides File</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Columns: <strong>Product ID</strong>, <strong>Ceiling</strong>, <strong>Note</strong> (optional).
        </p>
        <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Product Override' : 'Add Product Override'} size="md">
        <div className="flex flex-col gap-3">
          <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} placeholder="e.g. HM0806" />
          <Input label="Ceiling *" type="number" value={form.expected_limit} onChange={(e) => setForm({ ...form, expected_limit: e.target.value })} />
          <Input label="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Counted in ounces, not cases" />
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
