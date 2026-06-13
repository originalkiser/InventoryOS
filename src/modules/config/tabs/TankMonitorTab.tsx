import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal, Combobox, Select } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { TankMonitor, ColumnMapping } from '@/types'
import { format } from 'date-fns'

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'reading_date', label: 'Reading Date' },
  { name: 'value', label: 'Value' },
  { name: 'unit', label: 'Unit' },
]
const col = createColumnHelper<TankMonitor>()
const today = () => format(new Date(), 'yyyy-MM-dd')
const EMPTY = { locationId: '', reading_date: today(), value: '', unit: 'gal' }

export function TankMonitorTab() {
  const { data, loading, insert, update, remove, importRows } = useConfigTab<TankMonitor>('tank_monitors')
  const loc = useLocations()
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: TankMonitor) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
    col.accessor('reading_date', { header: 'Date', cell: (i) => { try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM d, yyyy') } catch { return i.getValue() } } }),
    col.accessor('value', { header: 'Value', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('unit', { header: 'Unit', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => i.getValue() ? format(new Date(i.getValue()), 'MMM d, yyyy') : '—' }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as TankMonitor)} className="text-xs font-mono text-[#00e5ff] hover:underline">Edit</button> },
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: TankMonitor) {
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', reading_date: r.reading_date ?? today(), value: r.value?.toString() ?? '', unit: r.unit ?? 'gal' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null, reading_date = today(), value: number | null = null, unit = 'gal'
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'reading_date') reading_date = v || today()
        else if (m.fieldName === 'value') value = num(v)
        else if (m.fieldName === 'unit') unit = v || 'gal'
      }
      return { location_id, reading_date, value, unit } as Partial<TankMonitor>
    }).filter((r: any) => r.location_id || r.value != null)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.reading_date}` })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.locationId) return
    const payload = { location_id: form.locationId, reading_date: form.reading_date, value: num(form.value), unit: form.unit } as Partial<TankMonitor>
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
            <Input label="Date" type="date" value={form.reading_date} onChange={(e) => setForm({ ...form, reading_date: e.target.value })} />
            <Input label="Value" type="number" step="0.01" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            <Select label="Unit" options={[{ value: 'gal', label: 'Gallons' }, { value: 'qt', label: 'Quarts' }]} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </div>
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
