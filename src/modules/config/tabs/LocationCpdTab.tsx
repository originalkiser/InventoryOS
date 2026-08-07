import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ColumnMapping } from '@/types'
import { format } from 'date-fns'

interface LocationCpd {
  id: string
  company_id: string
  location_id: string | null
  cpd: number | null
  effective_month: string | null
  metadata: Record<string, unknown> | null
  updated_at: string
  last_change_source: string | null
}

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}
function monthKey(v: string): string | null {
  const t = v.trim(); if (!t) return null
  const m = /^(\d{4})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-01`
  const d = new Date(t)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

const col = createColumnHelper<LocationCpd>()

export function LocationCpdTab() {
  const { data, loading, insert, update, remove, importRows, clearAll } =
    useConfigTab<LocationCpd>('location_cpd', 'inventory')
  const loc = useLocations()

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ locationId: '', cpd: '', month: '' })

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: LocationCpd) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
    col.accessor('cpd', { header: 'Cars / Day', cell: (i) => (i.getValue() == null ? '—' : i.getValue()!.toLocaleString()) }),
    col.accessor('cpd', {
      id: 'tier', header: 'Tier',
      cell: (i) => { const v = i.getValue(); return v == null ? '—' : v <= 30 ? '0–30' : '30+' },
    }),
    col.accessor('effective_month', {
      header: 'Effective Month',
      cell: (i) => { const v = i.getValue(); if (!v) return 'Default'; try { return format(new Date(v + 'T00:00:00'), 'MMM yyyy') } catch { return v } },
    }),
    col.accessor('updated_at', {
      header: 'Last Updated',
      cell: (i) => {
        const r = i.row.original as LocationCpd
        const s = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—'
      },
    }),
    {
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => <button onClick={() => openEdit(i.row.original as LocationCpd)} className="text-xs font-mono text-inky hover:underline">Edit</button>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  const uploadFields = [
    { name: 'location', label: 'Location', required: true },
    { name: 'cpd', label: 'Cars Per Day', required: true },
    { name: 'effective_month', label: 'Effective Month (optional)' },
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null
      let cpd: number | null = null
      let effective_month: string | null = null
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'location') location_id = loc.resolveId(raw)
        else if (m.fieldName === 'cpd') cpd = num(raw)
        else if (m.fieldName === 'effective_month') effective_month = monthKey(raw)
      }
      return { location_id, cpd, effective_month } as Partial<LocationCpd>
    }).filter((r) => r.location_id)
    // Merge on location + month so re-uploading a period updates in place.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.effective_month ?? ''}` })
    setImporting(false)
  }

  function resetForm() { setForm({ locationId: '', cpd: '', month: '' }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: LocationCpd) {
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', cpd: r.cpd?.toString() ?? '', month: (r.effective_month ?? '').slice(0, 7) })
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.locationId) return
    const payload = {
      location_id: form.locationId,
      cpd: num(form.cpd),
      effective_month: form.month ? monthKey(form.month) : null,
    } as Partial<LocationCpd>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this CPD row?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Location CPD (Cars Per Day)</h2>
        <p className="text-xs text-inky mt-0.5">
          Cars-per-day by shop. Drives which expectation tier a category uses: <strong>≤30</strong> → 0–30 CPD limit, <strong>&gt;30</strong> → 30+ CPD limit.
          Leave Effective Month blank for a shop's standing default.
        </p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="location_cpd.csv" exportData={data} loading={loading}
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <Button size="sm" onClick={openAdd}>+ Add CPD</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload CPD File</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Columns: <strong>Location</strong>, <strong>Cars Per Day</strong>, and optionally <strong>Effective Month</strong>.
        </p>
        <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit CPD' : 'Add CPD'} size="md">
        <div className="flex flex-col gap-3">
          <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Cars Per Day" type="number" value={form.cpd} onChange={(e) => setForm({ ...form, cpd: e.target.value })} />
            <Input label="Effective Month" type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
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
