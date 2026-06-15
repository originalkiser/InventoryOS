import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ProductUsage, ColumnMapping } from '@/types'
import { format } from 'date-fns'

export const EXCLUDE_NOT_IN_ORDER_KEY = 'product_usage.excludeNotInOrderConfig'

function num(v: string): number | null { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }

// on_hands / daily_usage, guarding divide-by-zero.
export function daysOfSupply(onHands: number | null, dailyUsage: number | null): number | null {
  if (dailyUsage == null || dailyUsage <= 0) return null
  if (onHands == null) return null
  return onHands / dailyUsage
}
function dosDisplay(d: number | null, onHands: number | null): string {
  if (d == null) return onHands != null && onHands > 0 ? '∞' : '—'
  return d.toFixed(1)
}

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'on_hands', label: 'On Hands' },
]

const col = createColumnHelper<ProductUsage>()
const EMPTY = { locationId: '', product_id: '', daily_usage: '', on_hands: '' }

export function ProductUsageTab() {
  const { data, loading, insert, update, remove, importRows } = useConfigTab<ProductUsage>('product_usage')
  const loc = useLocations()
  const [exclude, setExclude] = useAppSetting<boolean>(EXCLUDE_NOT_IN_ORDER_KEY, false)
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: ProductUsage) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
    col.accessor('product_id', { header: 'Product ID' }),
    col.accessor('daily_usage', { header: 'Daily Usage', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('on_hands', { header: 'On Hands', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('days_of_supply', { header: 'Days of Supply', cell: (i) => { const r = i.row.original as ProductUsage; return dosDisplay(i.getValue(), r.on_hands) } }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as ProductUsage)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ], [loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  function resetForm() { setForm({ ...EMPTY }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: ProductUsage) {
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', product_id: r.product_id ?? '', daily_usage: r.daily_usage?.toString() ?? '', on_hands: r.on_hands?.toString() ?? '' })
    setAddOpen(true)
  }

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null, product_id = '', daily_usage: number | null = null, on_hands: number | null = null
      for (const m of maps) {
        const v = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product_id') product_id = v
        else if (m.fieldName === 'daily_usage') daily_usage = num(v)
        else if (m.fieldName === 'on_hands') on_hands = num(v)
      }
      return { location_id, product_id, daily_usage, on_hands, days_of_supply: daysOfSupply(on_hands, daily_usage) } as Partial<ProductUsage>
    }).filter((r: any) => r.product_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}` })
    setImporting(false)
  }

  async function onSubmit() {
    if (!form.product_id.trim()) return
    const du = num(form.daily_usage), oh = num(form.on_hands)
    const payload = { location_id: form.locationId || null, product_id: form.product_id.trim(), daily_usage: du, on_hands: oh, days_of_supply: daysOfSupply(oh, du) } as Partial<ProductUsage>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this product-usage row?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Product Usage</h2>
        <p className="text-xs text-inky mt-0.5">Daily usage, on-hands, and days of supply by location. Use a Divide transform on Daily Usage to convert a period total to a daily figure.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="product_usage.csv" exportData={data} loading={loading}
        actions={<>
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={exclude} onChange={setExclude} size="sm" color="amber" />
            Exclude products not in order config
          </label>
          <Button size="sm" onClick={openAdd}>+ Add Row</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
        <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Product Usage' : 'Add Product Usage'} size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Location" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-3 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Daily Usage" type="number" step="0.01" value={form.daily_usage} onChange={(e) => setForm({ ...form, daily_usage: e.target.value })} />
            <Input label="On Hands" type="number" step="0.01" value={form.on_hands} onChange={(e) => setForm({ ...form, on_hands: e.target.value })} />
          </div>
          <p className="text-xs font-mono text-inky">Days of Supply: <span className="text-inky">{dosDisplay(daysOfSupply(num(form.on_hands), num(form.daily_usage)), num(form.on_hands))}</span></p>
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
