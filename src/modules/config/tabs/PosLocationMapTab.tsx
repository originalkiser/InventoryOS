import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal, Combobox, Badge } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import { applyTransforms } from '@/lib/transforms'
import type { PosLocationMap, ColumnMapping } from '@/types'

const REQUIRED_FIELDS = [
  { name: 'pos_string', label: 'Location String', required: true },
  { name: 'location_code', label: 'Location Code (force match)' },
  { name: 'location', label: 'Location (code/name)' },
]
const col = createColumnHelper<PosLocationMap>()
const EMPTY = { pos_string: '', locationId: '' }

export function PosLocationMapTab() {
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<PosLocationMap>('pos_location_map')
  const loc = useLocations()
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const columns = useMemo(() => [
    col.accessor('pos_string', { header: 'Location String' }),
    { id: 'parsed', header: 'Parsed #', accessorFn: (r: PosLocationMap) => applyTransforms(r.pos_string, [{ kind: 'pos_location' }]), cell: (i: any) => i.getValue() || 'â€”' },
    { id: 'location', header: 'Location Code', accessorFn: (r: PosLocationMap) => r.location_id, cell: (i: any) => (i.getValue() ? <span className="text-inky">{loc.codeOf(i.getValue())}</span> : <Badge color="amber">Unmatched</Badge>) },
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as PosLocationMap)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function openAdd() { setEditId(null); setForm({ ...EMPTY }); setAddOpen(true) }
  function openEdit(r: PosLocationMap) { setEditId(r.id); setForm({ pos_string: r.pos_string ?? '', locationId: r.location_id ?? '' }); setAddOpen(true) }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let pos_string = '', location_id: string | null = null, code = ''
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        if (m.fieldName === 'pos_string') pos_string = v
        else if (m.fieldName === 'location_code') code = v
        else if (m.fieldName === 'location') location_id = loc.resolveId(v)
      }
      // Priority: explicit location_code (force match) â†’ location â†’ parsed leading number.
      if (!location_id && code) location_id = loc.resolveId(code)
      if (!location_id && pos_string) location_id = loc.resolveId(applyTransforms(pos_string, [{ kind: 'pos_location' }]))
      return { pos_string, location_id } as Partial<PosLocationMap>
    }).filter((r: any) => r.pos_string)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => String(r.pos_string ?? '').toLowerCase() })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.pos_string.trim()) return
    const payload = { pos_string: form.pos_string.trim(), location_id: form.locationId || null } as Partial<PosLocationMap>
    if (editId) await update(editId, payload)
    else await insert(payload)
    setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }
  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this mapping?')) return
    await remove(editId); setForm({ ...EMPTY }); setAddOpen(false); setEditId(null)
  }

  const unmatched = data.filter((r) => !r.location_id).length

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className=”text-sm font-bold text-navy uppercase tracking-wide”>Location Mapping</h2>
        <p className=”text-xs text-inky mt-0.5”>Map location strings from any reporter (e.g. &quot;1 - Thomasville&quot;, &quot;Store 001&quot;) to internal locations. Imports auto-match on leading numbers; merge mode adds new strings without removing existing ones. {unmatched > 0 ? <span className=”text-orange-600”>{unmatched} unmatched â€” map them below.</span> : 'All mapped.'}</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="pos_location_map.csv" exportData={data} loading={loading}
        actions={<><ClearTableButton clearAll={clearAll} /><Button size="sm" onClick={openAdd}>+ Add Mapping</Button></>} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="pos_location_map" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Mapping' : 'Add Mapping'}>
        <div className="flex flex-col gap-3">
          <Input label="Location String *" value={form.pos_string} onChange={(e) => setForm({ ...form, pos_string: e.target.value })} placeholder="e.g. 1 - Thomasville, Store 001" />
          <Combobox label="Location" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.pos_string.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
