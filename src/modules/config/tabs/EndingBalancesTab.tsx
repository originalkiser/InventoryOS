import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { MonthlyEndingBalance, ColumnMapping } from '@/types'
import { format } from 'date-fns'

const RECOMMENDED = [
  { label: 'Food', field_type: 'number' as const },
  { label: 'Beverage', field_type: 'number' as const },
  { label: 'Paper & Supplies', field_type: 'number' as const },
]

const fmt = (v: number | null) =>
  v != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) : '—'

// Normalize any month input ('YYYY-MM', a date) to a first-of-month 'YYYY-MM-01'.
function monthKey(v: string): string | null {
  const t = v.trim()
  if (!t) return null
  const m = /^(\d{4})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-01`
  const d = new Date(t)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}

const col = createColumnHelper<MonthlyEndingBalance>()

export function EndingBalancesTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, update, remove, importRows } = useConfigTab<MonthlyEndingBalance>('monthly_ending_balances')
  const { active: categories, addField } = useCustomFields('ending_balance')
  const loc = useLocations()

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  const [form, setForm] = useState({ locationId: '', month: '', ending_balance: '' })
  const [catVals, setCatVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'location', header: 'Location', accessorFn: (r: MonthlyEndingBalance) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
      col.accessor('month', { header: 'Month', cell: (i) => { try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM yyyy') } catch { return i.getValue() } } }),
      col.accessor('ending_balance', { header: 'Ending Balance', cell: (i) => fmt(i.getValue()) }),
    ]
    for (const c of categories) {
      cols.push({ id: `cf_${c.field_key}`, header: c.label, accessorFn: (r: MonthlyEndingBalance) => (r.metadata as any)?.[c.field_key] ?? '', cell: (i: any) => (i.getValue() === '' ? '—' : fmt(Number(i.getValue()))) })
    }
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as MonthlyEndingBalance; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as MonthlyEndingBalance)} className="text-xs font-mono text-[#00e5ff] hover:underline">Edit</button> })
    return cols
  }, [categories, loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  const uploadFields = [
    { name: 'location', label: 'Location', required: true },
    { name: 'month', label: 'Month', required: true },
    { name: 'ending_balance', label: 'Ending Balance', required: true },
    ...categories.map((c) => ({ name: c.field_key, label: c.label })),
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const catKeys = new Set(categories.map((c) => c.field_key))
    const payload = rows.map((row) => {
      const meta: Record<string, unknown> = {}
      let location_id: string | null = null
      let month: string | null = null
      let ending_balance: number | null = null
      for (const m of maps) {
        const raw = mappedValue(row, m)
        if (m.fieldName === 'location') location_id = loc.resolveId(raw)
        else if (m.fieldName === 'month') month = monthKey(raw)
        else if (m.fieldName === 'ending_balance') ending_balance = num(raw)
        else if (catKeys.has(m.fieldName)) meta[m.fieldName] = num(raw)
      }
      return { location_id, month, ending_balance: ending_balance ?? 0, metadata: meta } as Partial<MonthlyEndingBalance>
    }).filter((r) => r.month)
    // Stack monthly: match on location + month so re-uploading a month updates it
    // while all prior months stay.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.month}` })
    setImporting(false)
  }

  function resetForm() { setForm({ locationId: '', month: '', ending_balance: '' }); setCatVals({}) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: MonthlyEndingBalance) {
    setEditId(r.id)
    setForm({ locationId: r.location_id ?? '', month: (r.month ?? '').slice(0, 7), ending_balance: r.ending_balance?.toString() ?? '' })
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    setCatVals(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v == null ? '' : String(v)])))
    setAddOpen(true)
  }

  async function onSubmit() {
    const month = monthKey(form.month)
    if (!form.locationId || !month) return
    const meta: Record<string, unknown> = {}
    for (const c of categories) meta[c.field_key] = num(catVals[c.field_key] ?? '')
    const payload = { location_id: form.locationId, month, ending_balance: num(form.ending_balance) ?? 0, metadata: meta } as Partial<MonthlyEndingBalance>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this ending-balance row?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-white uppercase tracking-wide">Month End Ending Balance</h2>
        <p className="text-xs text-gray-500 mt-0.5">Location-specific ending balances by month. Uploads stack — prior months are always kept.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="month_end_ending_balance.csv" exportData={data} loading={loading}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Categories</Button>
          <Button size="sm" onClick={openAdd}>+ Add Balance</Button>
        </>}
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} onAddColumn={(label) => addField({ label, field_type: 'number' })} />
        </div>
        <DataSourceLinker configType="monthly_ending_balances" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Ending Balance' : 'Add Ending Balance'} size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Location *" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Month *" type="month" value={form.month} onChange={(e) => setForm({ ...form, month: e.target.value })} />
            <Input label="Ending Balance *" type="number" step="0.01" value={form.ending_balance} onChange={(e) => setForm({ ...form, ending_balance: e.target.value })} />
            {categories.map((c) => (
              <Input key={c.id} label={c.label} type="number" step="0.01" value={catVals[c.field_key] ?? ''} onChange={(e) => setCatVals({ ...catVals, [c.field_key]: e.target.value })} />
            ))}
          </div>
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.locationId || !form.month}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={columnsOpen} onClose={() => setColumnsOpen(false)} title="Ending-Balance Categories" size="lg">
        <CustomFieldsEditor section="ending_balance" recommended={RECOMMENDED} />
      </Modal>
    </div>
  )
}
