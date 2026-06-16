import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { UomMapping, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'from_unit', label: 'From Unit (on-hand)', required: true },
  { name: 'to_unit', label: 'To Unit (order)', required: true },
  { name: 'factor', label: 'Factor', required: true },
]

const col = createColumnHelper<UomMapping>()
const EMPTY = { from_unit: '', to_unit: '', factor: '' }

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }

export function UomMappingsTab() {
  const { data, loading, insert, update, remove, importRows } = useConfigTab<UomMapping>('uom_mappings')
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const COLUMNS = [
    col.accessor('from_unit', { header: 'From (on-hand)' }),
    col.accessor('to_unit', { header: 'To (order)' }),
    col.accessor('factor', { header: 'Factor', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as UomMapping)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ]
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: UomMapping) {
    setEditId(r.id)
    setForm({ from_unit: r.from_unit ?? '', to_unit: r.to_unit ?? '', factor: r.factor?.toString() ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) {
        const v = mappedValue(row, m)
        out[m.fieldName] = m.fieldName === 'factor' ? num(v) : (v || null)
      }
      return out as Partial<UomMapping>
    }).filter((r: any) => r.from_unit && r.to_unit)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${String(r.from_unit ?? '').toLowerCase()}|${String(r.to_unit ?? '').toLowerCase()}` })
    setImporting(false)
  }

  async function onSubmit() {
    const factor = num(form.factor)
    if (!form.from_unit.trim() || !form.to_unit.trim() || factor == null) return
    const payload = { from_unit: form.from_unit.trim(), to_unit: form.to_unit.trim(), factor } as Partial<UomMapping>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this UoM mapping?')) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Unit-of-Measure Conversions</h2>
        <p className="text-xs text-inky mt-0.5">Factor to convert an on-hand unit into an order unit. E.g. EA → CS factor 0.0833 means 12 each = 1 case. Set a product&apos;s order unit on Global Products.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="uom_mappings.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={openAdd}>+ Add Mapping</Button>}
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="uom_mappings" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit UoM Mapping' : 'Add UoM Mapping'}>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <Input label="From Unit *" value={form.from_unit} onChange={(e) => setForm({ ...form, from_unit: e.target.value })} placeholder="EA" />
            <Input label="To Unit *" value={form.to_unit} onChange={(e) => setForm({ ...form, to_unit: e.target.value })} placeholder="CS" />
            <Input label="Factor *" value={form.factor} onChange={(e) => setForm({ ...form, factor: e.target.value })} placeholder="0.0833" />
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.from_unit.trim() || !form.to_unit.trim() || num(form.factor) == null}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
