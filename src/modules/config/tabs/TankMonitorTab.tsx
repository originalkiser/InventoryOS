import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { TankMonitor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
const truthy = (v: string) => ['true', '1', 'yes', 'y', 'keep', 'enabled'].includes(v.trim().toLowerCase())

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product' },
  { name: 'keep_fill', label: 'Keep-fill enabled?' },
  { name: 'reading_date', label: 'Inventory Date' },
  { name: 'on_hand', label: 'On Hand' },
]
const col = createColumnHelper<TankMonitor>()
const today = () => format(new Date(), 'yyyy-MM-dd')
const EMPTY = { locationId: '', product_id: '', keep_fill: false, reading_date: today(), on_hand: '' }

export function TankMonitorTab() {
  const { data, loading, insert, update, remove, importRows } = useConfigTab<TankMonitor>('tank_monitors')
  const loc = useLocations()
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: TankMonitor) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
    col.accessor('product_id', { header: 'Product', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('keep_fill', { header: 'Keep-fill', cell: (i) => (i.getValue() ? '✓' : '—') }),
    col.accessor('reading_date', { header: 'Inventory Date', cell: (i) => { try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM d, yyyy') } catch { return i.getValue() } } }),
    col.accessor('on_hand', { header: 'On Hand', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => i.getValue() ? format(new Date(i.getValue()), 'MMM d, yyyy') : '—' }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as TankMonitor)} className="text-xs font-mono text-[#00e5ff] hover:underline">Edit</button> },
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: TankMonitor) {
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', product_id: r.product_id ?? '', keep_fill: !!r.keep_fill, reading_date: r.reading_date ?? today(), on_hand: r.on_hand?.toString() ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null, product_id = '', keep_fill = false, reading_date = today(), on_hand: number | null = null
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product_id') product_id = v
        else if (m.fieldName === 'keep_fill') keep_fill = truthy(v)
        else if (m.fieldName === 'reading_date') reading_date = v || today()
        else if (m.fieldName === 'on_hand') on_hand = num(v)
      }
      return { location_id, product_id: product_id || null, keep_fill, reading_date, on_hand } as Partial<TankMonitor>
    }).filter((r: any) => r.location_id || r.product_id)
    // One reading per location + product + date.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}|${r.reading_date}` })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.locationId) return
    const payload = { location_id: form.locationId, product_id: form.product_id.trim() || null, keep_fill: form.keep_fill, reading_date: form.reading_date, on_hand: num(form.on_hand) } as Partial<TankMonitor>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }
  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this reading?')) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-white uppercase tracking-wide">Tank Monitor</h2>
        <p className="text-xs text-gray-500 mt-0.5">Daily readings by location. Use transforms on import for gallons↔quarts or to parse the location number from a messy export.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="tank_monitors.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={openAdd}>+ Add Reading</Button>} />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
        <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Reading' : 'Add Reading'}>
        <div className="flex flex-col gap-3">
          <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Product" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Inventory Date" type="date" value={form.reading_date} onChange={(e) => setForm({ ...form, reading_date: e.target.value })} />
            <Input label="On Hand" type="number" step="0.01" value={form.on_hand} onChange={(e) => setForm({ ...form, on_hand: e.target.value })} />
          </div>
          <Toggle checked={form.keep_fill} onChange={(v) => setForm({ ...form, keep_fill: v })} label="Keep-fill enabled?" color="green" />
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.locationId}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
