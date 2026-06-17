import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { CustomFieldsEditor } from '@/components/config/CustomFieldsEditor'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { Button, Input, Modal, Combobox } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { MonthlyEndingBalance, ColumnMapping } from '@/types'
import type { ParseResult } from '@/lib/fileParser'
import { format } from 'date-fns'

const RECOMMENDED = [
  { label: 'Food', field_type: 'number' as const },
  { label: 'Beverage', field_type: 'number' as const },
  { label: 'Paper & Supplies', field_type: 'number' as const },
]

const fmt = (v: number | null) =>
  v != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) : 'â€”'

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

// Parse pivot column header "Aug-25" → "2025-08-01"
const PIVOT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
function parsePivotMonth(header: string): string | null {
  const match = /^([A-Za-z]{3})-(\d{2})$/.exec(header.trim())
  if (!match) return null
  const idx = PIVOT_MONTHS.indexOf(match[1].toLowerCase())
  if (idx === -1) return null
  return `${2000 + parseInt(match[2], 10)}-${String(idx + 1).padStart(2, '0')}-01`
}

const col = createColumnHelper<MonthlyEndingBalance>()

export function EndingBalancesTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<MonthlyEndingBalance>('monthly_ending_balances')
  const { active: categories, addField } = useCustomFields('ending_balance')
  const loc = useLocations()

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pivotParsed, setPivotParsed] = useState<ParseResult | null>(null)
  const [pivotImporting, setPivotImporting] = useState(false)

  const [form, setForm] = useState({ locationId: '', month: '', ending_balance: '' })
  const [catVals, setCatVals] = useState<Record<string, string>>({})

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'location', header: 'Location', accessorFn: (r: MonthlyEndingBalance) => loc.labelOf(r.location_id), cell: (i: any) => i.getValue() },
      col.accessor('month', { header: 'Month', cell: (i) => { try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM yyyy') } catch { return i.getValue() } } }),
      col.accessor('ending_balance', { header: 'Ending Balance', cell: (i) => fmt(i.getValue()) }),
    ]
    for (const c of categories) {
      cols.push({ id: `cf_${c.field_key}`, header: c.label, accessorFn: (r: MonthlyEndingBalance) => (r.metadata as any)?.[c.field_key] ?? '', cell: (i: any) => (i.getValue() === '' ? 'â€”' : fmt(Number(i.getValue()))) })
    }
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as MonthlyEndingBalance; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : 'â€”' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as MonthlyEndingBalance)} className="text-xs font-mono text-inky hover:underline">Edit</button> })
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

  async function handlePivotImport() {
    if (!pivotParsed) return
    setPivotImporting(true)
    const { headers, rows } = pivotParsed
    const locationCol = headers[0]
    const monthCols = headers.slice(1).filter((h) => parsePivotMonth(h) !== null)
    const payload: Partial<MonthlyEndingBalance>[] = []
    for (const row of rows) {
      const locRaw = (row[locationCol] ?? '').trim()
      if (!locRaw) continue
      const location_id = loc.resolveId(locRaw)
      for (const col of monthCols) {
        const month = parsePivotMonth(col)
        if (!month) continue
        const ending_balance = num(row[col] ?? '')
        if (ending_balance === null) continue
        payload.push({ location_id, month, ending_balance, metadata: {} })
      }
    }
    await importRows(payload, { mode: 'merge', source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.month}` })
    setPivotParsed(null)
    setPivotImporting(false)
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
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Month End Ending Balance</h2>
        <p className="text-xs text-inky mt-0.5">Location-specific ending balances by month. Uploads stack â€” prior months are always kept.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="month_end_ending_balance.csv" exportData={data} loading={loading}
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Categories</Button>
          <Button size="sm" onClick={openAdd}>+ Add Balance</Button>
        </>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File (Tall Format)</h3>
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} onAddColumn={(label) => addField({ label, field_type: 'number' })} />
        </div>
        <DataSourceLinker configType="monthly_ending_balances" />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Pivot / Wide Format Upload</h3>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">
            First column = Location code · Remaining columns = months in "Aug-25" format · Values = dollar amounts
          </p>
        </div>
        {!pivotParsed ? (
          <div className="max-w-lg">
            <FileUploadZone onParsed={(r) => setPivotParsed(r)} label="Drop pivot CSV / Excel here, or click to browse" />
          </div>
        ) : (
          <PivotPreview
            parsed={pivotParsed}
            importing={pivotImporting}
            onImport={handlePivotImport}
            onCancel={() => setPivotParsed(null)}
          />
        )}
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

function PivotPreview({
  parsed, importing, onImport, onCancel,
}: { parsed: ParseResult; importing: boolean; onImport: () => void; onCancel: () => void }) {
  const locationCol = parsed.headers[0]
  const monthCols = parsed.headers.slice(1).filter((h) => parsePivotMonth(h) !== null)
  const unrecognized = parsed.headers.slice(1).filter((h) => parsePivotMonth(h) === null)
  const locationCount = new Set(parsed.rows.map((r) => r[locationCol]).filter(Boolean)).size
  const totalRows = locationCount * monthCols.length

  if (monthCols.length === 0) {
    return (
      <div className="flex flex-col gap-3 max-w-lg">
        <div className="rounded border border-red-500/30 bg-red-500/10 px-4 py-3">
          <p className="text-xs font-mono text-red-400">
            No month columns detected. Headers must be in "Aug-25" format (3-letter month + 2-digit year).
          </p>
          {unrecognized.length > 0 && (
            <p className="text-[11px] font-mono text-red-400/70 mt-1">
              Found: {unrecognized.slice(0, 6).join(', ')}{unrecognized.length > 6 ? ` +${unrecognized.length - 6} more` : ''}
            </p>
          )}
        </div>
        <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 max-w-lg">
      <div className="rounded border border-navy/20 bg-navy/5 px-4 py-3 flex flex-col gap-1.5">
        <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Preview</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono text-inky">
          <span className="text-inky/50">Months detected</span>
          <span>{monthCols.length} ({monthCols[0]} → {monthCols[monthCols.length - 1]})</span>
          <span className="text-inky/50">Locations</span>
          <span>{locationCount}</span>
          <span className="text-inky/50">Rows to upsert</span>
          <span>~{totalRows}</span>
        </div>
        {unrecognized.length > 0 && (
          <p className="text-[11px] font-mono text-inky/40 mt-1">
            Skipping {unrecognized.length} unrecognized column{unrecognized.length > 1 ? 's' : ''}: {unrecognized.slice(0, 4).join(', ')}{unrecognized.length > 4 ? '…' : ''}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onImport} loading={importing}>Import {totalRows} Rows</Button>
        <Button size="sm" variant="secondary" onClick={onCancel} disabled={importing}>Cancel</Button>
      </div>
    </div>
  )
}
