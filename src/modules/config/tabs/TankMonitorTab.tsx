import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import { applyTransforms } from '@/lib/transforms'
import type { TankMonitor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
const truthy = (v: string) => ['true', '1', 'yes', 'y', 'keep', 'enabled'].includes(v.trim().toLowerCase())
// Safe parse a date/time value (handles Excel serials, rejects absurd years).
const toIso = (v: string) => applyTransforms(v, [{ kind: 'datetime' }]) || null
const toDate = (v: string) => applyTransforms(v, [{ kind: 'date' }]) || null

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product' },
  { name: 'keep_fill', label: 'Keep-fill enabled?' },
  { name: 'inventory_time', label: 'Inventory Time (date & time)' },
  { name: 'on_hand', label: 'On Hand' },
]
const col = createColumnHelper<TankMonitor>()
const today = () => format(new Date(), 'yyyy-MM-dd')
// datetime-local wants "yyyy-MM-ddTHH:mm".
const nowLocal = () => format(new Date(), "yyyy-MM-dd'T'HH:mm")
const EMPTY = { locationId: '', product_id: '', keep_fill: false, inventory_time: nowLocal(), on_hand: '' }

export function TankMonitorTab() {
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<TankMonitor>('tank_monitors')
  const loc = useLocations()
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: TankMonitor) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
    col.accessor('product_id', { header: 'Product', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('keep_fill', { header: 'Keep-fill', cell: (i) => (i.getValue() ? 'âœ“' : 'â€”') }),
    { id: 'inventory_time', header: 'Inventory Time', accessorFn: (r: TankMonitor) => r.inventory_time ?? r.reading_date, cell: (i: any) => { const v = i.getValue(); if (!v) return 'â€”'; try { return format(new Date(v), 'MMM d, yyyy h:mm a') } catch { return String(v) } } },
    col.accessor('on_hand', { header: 'On Hand', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => i.getValue() ? format(new Date(i.getValue()), 'MMM d, yyyy') : 'â€”' }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as TankMonitor)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: TankMonitor) {
    const it = r.inventory_time ? format(new Date(r.inventory_time), "yyyy-MM-dd'T'HH:mm") : (r.reading_date ? `${r.reading_date}T00:00` : nowLocal())
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', product_id: r.product_id ?? '', keep_fill: !!r.keep_fill, inventory_time: it, on_hand: r.on_hand?.toString() ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null, product_id = '', keep_fill = false, inventory_time: string | null = null, reading_date: string | null = null, on_hand: number | null = null
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product_id') product_id = v
        else if (m.fieldName === 'keep_fill') keep_fill = truthy(v)
        else if (m.fieldName === 'inventory_time') { inventory_time = toIso(v); reading_date = toDate(v) }
        else if (m.fieldName === 'on_hand') on_hand = num(v)
      }
      if (!reading_date) reading_date = today()
      return { location_id, product_id: product_id || null, keep_fill, inventory_time, reading_date, on_hand } as Partial<TankMonitor>
    }).filter((r: any) => r.location_id || r.product_id)
    // One reading per location + product + date.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}|${r.reading_date}` })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.locationId) return
    const d = form.inventory_time ? new Date(form.inventory_time) : null
    const payload = {
      location_id: form.locationId, product_id: form.product_id.trim() || null, keep_fill: form.keep_fill,
      inventory_time: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      reading_date: d && !isNaN(d.getTime()) ? format(d, 'yyyy-MM-dd') : today(),
      on_hand: num(form.on_hand),
    } as Partial<TankMonitor>
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
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Tank Monitor</h2>
        <p className="text-xs text-inky mt-0.5">Daily readings by location. Use transforms on import for gallonsâ†”quarts or to parse the location number from a messy export.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="tank_monitors.csv" exportData={data} loading={loading}
        actions={<><ClearTableButton clearAll={clearAll} /><Button size="sm" onClick={openAdd}>+ Add Reading</Button></>} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="tank_monitor" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Reading' : 'Add Reading'}>
        <div className="flex flex-col gap-3">
          <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Product" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Inventory Time" type="datetime-local" value={form.inventory_time} onChange={(e) => setForm({ ...form, inventory_time: e.target.value })} />
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
