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
import { Button, Input, Modal, Combobox, Select } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { MonthlyEndingBalance, ColumnMapping } from '@/types'
import { parseAllSheets, type ParseResult, type SheetParseResult } from '@/lib/fileParser'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const RECOMMENDED = [
  { label: 'Parts', field_type: 'number' as const },
  { label: 'Oil', field_type: 'number' as const },
  { label: 'Additives', field_type: 'number' as const },
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

// Sentinel for "don't import this sheet" in the workbook mapper.
const SHEET_SKIP = '__skip__'

// Stable merge key for an ending-balance row. Resolved shops key on location_id;
// unresolved (inactive / absent) shops key on their raw uploaded name so each
// keeps a distinct row instead of collapsing onto one shared null key.
function ebKey(locationId: string | null, rawLoc: string, month: string | null | undefined): string {
  const locKey = locationId ?? `raw:${rawLoc.trim().toLowerCase()}`
  return `${locKey}|${month ?? ''}`
}

// Parse a pivot column header into a first-of-month key. Accepts:
//   "Aug-25"            → 2025-08-01
//   "07/31/2026"        → 2026-07-01  (MM/DD/YYYY, 2- or 4-digit year)
//   ISO / other Date-parseable strings (e.g. a real date cell) as a fallback.
const PIVOT_MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
function parsePivotMonth(header: string): string | null {
  const t = header.trim()
  if (!t) return null
  const abbr = /^([A-Za-z]{3})-(\d{2})$/.exec(t)
  if (abbr) {
    const idx = PIVOT_MONTHS.indexOf(abbr[1].toLowerCase())
    if (idx !== -1) return `${2000 + parseInt(abbr[2], 10)}-${String(idx + 1).padStart(2, '0')}-01`
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t)
  if (slash) {
    const mo = parseInt(slash[1], 10)
    let yr = parseInt(slash[3], 10)
    if (yr < 100) yr += 2000
    if (mo >= 1 && mo <= 12) return `${yr}-${String(mo).padStart(2, '0')}-01`
  }
  const d = new Date(t)
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
  return null
}

const col = createColumnHelper<MonthlyEndingBalance>()

export function EndingBalancesTab() {
  const { profile } = useAuthStore()
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } = useConfigTab<MonthlyEndingBalance>('monthly_ending_balances', 'inventory')
  const { active: categories, addField } = useCustomFields('ending_balance')
  const loc = useLocations()

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pivotParsed, setPivotParsed] = useState<ParseResult | null>(null)
  const [pivotImporting, setPivotImporting] = useState(false)
  // '' = Total ending balance; otherwise a category field_key (Parts/Oil/Additives).
  const [pivotTarget, setPivotTarget] = useState('')
  // Multi-sheet workbook upload (one sheet per category + a Total sheet).
  const [workbookSheets, setWorkbookSheets] = useState<SheetParseResult[] | null>(null)
  const [sheetTargets, setSheetTargets] = useState<Record<string, string>>({})
  const [workbookImporting, setWorkbookImporting] = useState(false)

  const [form, setForm] = useState({ locationId: '', month: '', ending_balance: '' })
  const [catVals, setCatVals] = useState<Record<string, string>>({})
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Display an inactive (present but not active) or absent shop with an
  // "(Inactive)" prefix, falling back to the uploaded name for absent shops.
  function locDisplay(r: MonthlyEndingBalance): string {
    const l = loc.byId(r.location_id)
    const raw = (r.metadata as any)?._raw_location as string | undefined
    if (l && l.active) return `${l.name} — ${l.shop_city ?? ''}`
    if (l) return `(Inactive) ${l.name} — ${l.shop_city ?? ''}`
    return `(Inactive) ${raw ?? loc.labelOf(r.location_id)}`
  }

  // Subtotal of the currently-selected rows — filter to a month + select all to
  // reconcile against the upload file / monthly summary.
  const selectionSubtotal = useMemo(() => {
    if (selectedIds.size === 0) return null
    let total = 0
    let count = 0
    const cats: Record<string, number> = {}
    for (const r of data) {
      if (!selectedIds.has(r.id)) continue
      count++
      total += Number(r.ending_balance ?? 0)
      for (const c of categories) {
        const v = Number((r.metadata as any)?.[c.field_key])
        if (!isNaN(v)) cats[c.field_key] = (cats[c.field_key] ?? 0) + v
      }
    }
    return { count, total, cats }
  }, [selectedIds, data, categories])

  const columns = useMemo(() => {
    const cols: any[] = [
      { id: 'location', header: 'Location', accessorFn: (r: MonthlyEndingBalance) => locDisplay(r), cell: (i: any) => locDisplay(i.row.original as MonthlyEndingBalance) },
      col.accessor('month', { header: 'Month', cell: (i) => { try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM yyyy') } catch { return i.getValue() } } }),
      col.accessor('ending_balance', { header: 'Ending Balance', cell: (i) => fmt(i.getValue()) }),
    ]
    for (const c of categories) {
      cols.push({ id: `cf_${c.field_key}`, header: c.label, accessorFn: (r: MonthlyEndingBalance) => (r.metadata as any)?.[c.field_key] ?? '', cell: (i: any) => (i.getValue() === '' ? '—' : fmt(Number(i.getValue()))) })
    }
    cols.push(col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as MonthlyEndingBalance; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }))
    cols.push({ id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as MonthlyEndingBalance)} className="text-xs font-mono text-inky hover:underline">Edit</button> })
    return cols
  }, [categories, loc])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, { persistKey: 'config:ending-balances' })

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
      let rawLoc = ''
      let month: string | null = null
      let ending_balance: number | null = null
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'location') { rawLoc = raw.trim(); location_id = loc.resolveId(raw) }
        else if (m.fieldName === 'month') month = monthKey(raw)
        else if (m.fieldName === 'ending_balance') ending_balance = num(raw)
        else if (catKeys.has(m.fieldName)) meta[m.fieldName] = num(raw)
      }
      if (rawLoc) meta._raw_location = rawLoc
      return { location_id, month, ending_balance: ending_balance ?? 0, metadata: meta } as Partial<MonthlyEndingBalance>
    }).filter((r) => r.month)
    // Stack monthly: match on location + month so re-uploading a month updates it
    // while all prior months stay. Unresolved shops key on their raw name so they
    // don't collapse onto one shared null row.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => ebKey(r.location_id ?? null, (r.metadata as any)?._raw_location ?? '', r.month) })
    setImporting(false)
  }

  async function handlePivotImport() {
    if (!pivotParsed) return
    setPivotImporting(true)
    const { headers, rows } = pivotParsed
    const locationCol = headers[0]
    const monthCols = headers.slice(1).filter((h) => parsePivotMonth(h) !== null)
    // Existing rows keyed by location|month so a pivot import merges into the
    // stored row rather than replacing it (preserves total + other categories).
    const existingByKey = new Map<string, MonthlyEndingBalance>()
    for (const r of data) existingByKey.set(ebKey(r.location_id ?? null, (r.metadata as any)?._raw_location ?? '', r.month), r)
    const payload: Partial<MonthlyEndingBalance>[] = []
    for (const row of rows) {
      const locRaw = (row[locationCol] ?? '').trim()
      if (!locRaw) continue
      const location_id = loc.resolveId(locRaw)
      for (const col of monthCols) {
        const month = parsePivotMonth(col)
        if (!month) continue
        const value = num(row[col] ?? '')
        if (value === null) continue
        const existing = existingByKey.get(ebKey(location_id, locRaw, month))
        const baseMeta = { ...((existing?.metadata ?? {}) as Record<string, unknown>), _raw_location: locRaw }
        if (pivotTarget === '') {
          // Total ending balance — keep any category metadata already stored.
          payload.push({ location_id, month, ending_balance: value, metadata: baseMeta as any })
        } else {
          // Category pivot — set only this category; keep total + other categories.
          payload.push({ location_id, month, ending_balance: existing?.ending_balance ?? 0, metadata: { ...baseMeta, [pivotTarget]: value } as any })
        }
      }
    }
    await importRows(payload, { mode: 'merge', source: 'upload', keyOf: (r: any) => ebKey(r.location_id ?? null, (r.metadata as any)?._raw_location ?? '', r.month) })
    setPivotParsed(null)
    setPivotImporting(false)
  }

  // Guess a sheet's target from its name (e.g. "Oil" → oil category, "Total" → total).
  function autoTarget(sheetName: string): string {
    const n = sheetName.trim().toLowerCase()
    if (/total|ending|grand/.test(n)) return ''
    const hit = categories.find((c) => {
      const l = c.label.trim().toLowerCase()
      return l === n || n.includes(l)
    })
    return hit ? hit.field_key : SHEET_SKIP
  }

  async function onWorkbookFile(file: File) {
    try {
      const sheets = await parseAllSheets(file)
      setWorkbookSheets(sheets)
      const t: Record<string, string> = {}
      for (const s of sheets) t[s.name] = autoTarget(s.name)
      setSheetTargets(t)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to read workbook')
    }
  }

  async function handleWorkbookImport() {
    if (!workbookSheets) return
    setWorkbookImporting(true)
    const existingByKey = new Map<string, MonthlyEndingBalance>()
    for (const r of data) existingByKey.set(ebKey(r.location_id ?? null, (r.metadata as any)?._raw_location ?? '', r.month), r)

    type Acc = { location_id: string | null; month: string; ending_balance: number; metadata: Record<string, unknown> }
    const acc = new Map<string, Acc>()
    // Seed a row from the stored one the first time it's touched, so mapping one
    // sheet never drops the total or the other categories already on that row.
    const ensure = (location_id: string | null, rawLoc: string, month: string): Acc => {
      const key = ebKey(location_id, rawLoc, month)
      let e = acc.get(key)
      if (!e) {
        const existing = existingByKey.get(key)
        e = {
          location_id, month,
          ending_balance: Number(existing?.ending_balance ?? 0),
          metadata: { ...((existing?.metadata as Record<string, unknown>) ?? {}), _raw_location: rawLoc },
        }
        acc.set(key, e)
      }
      return e
    }

    for (const sheet of workbookSheets) {
      const target = sheetTargets[sheet.name]
      if (target === SHEET_SKIP || target === undefined) continue
      const { headers, rows } = sheet.result
      const locationCol = headers[0]
      const monthCols = headers.slice(1).filter((h) => parsePivotMonth(h) !== null)
      for (const row of rows) {
        const locRaw = (row[locationCol] ?? '').trim()
        if (!locRaw) continue
        const location_id = loc.resolveId(locRaw)
        for (const c of monthCols) {
          const month = parsePivotMonth(c)
          if (!month) continue
          const value = num(row[c] ?? '')
          if (value === null) continue
          const e = ensure(location_id, locRaw, month)
          if (target === '') e.ending_balance = value
          else e.metadata[target] = value
        }
      }
    }

    if (acc.size === 0) {
      setWorkbookImporting(false)
      toast.error('No month columns detected across the mapped sheets')
      return
    }
    const payload = [...acc.values()].map((e) => ({
      location_id: e.location_id, month: e.month, ending_balance: e.ending_balance, metadata: e.metadata as any,
    })) as Partial<MonthlyEndingBalance>[]
    await importRows(payload, { mode: 'merge', source: 'upload', keyOf: (r: any) => ebKey(r.location_id ?? null, (r.metadata as any)?._raw_location ?? '', r.month) })
    setWorkbookSheets(null); setSheetTargets({}); setWorkbookImporting(false)
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
        <p className="text-xs text-inky mt-0.5">Location-specific ending balances by month. Uploads stack — prior months are always kept.</p>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="month_end_ending_balance.csv" exportData={data} loading={loading}
        onSelectionChange={setSelectedIds}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<>
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>Manage Categories</Button>
          <Button size="sm" onClick={openAdd}>+ Add Balance</Button>
        </>}
      />

      {selectionSubtotal && selectionSubtotal.count > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded border border-sky/60 bg-sky/10 px-4 py-2.5">
          <span className="text-xs font-heading uppercase tracking-wide text-navy">
            Subtotal · {selectionSubtotal.count} selected
          </span>
          {categories.map((c) => (
            <span key={c.field_key} className="text-xs font-mono text-inky">
              {c.label}: <span className="text-navy font-bold">{fmt(selectionSubtotal.cats[c.field_key] ?? 0)}</span>
            </span>
          ))}
          <span className="text-xs font-mono text-inky">
            Total: <span className="text-navy font-bold">{fmt(selectionSubtotal.total)}</span>
          </span>
        </div>
      )}

      <CategoryBalanceComparison data={data} categories={categories} />

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
        <div className="w-64">
          <Select
            label="This file's balances are"
            options={[{ value: '', label: 'Total Ending Balance' }, ...categories.map((c) => ({ value: c.field_key, label: c.label }))]}
            value={pivotTarget}
            onChange={(e) => setPivotTarget(e.target.value)}
          />
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

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Workbook Upload — One Sheet per Category</h3>
          <p className="text-[11px] font-mono text-inky/60 mt-0.5">
            One Excel workbook with a sheet for Total, Parts, Oil, and Additives. Each sheet: shops in the first column,
            month columns (e.g. "Jul-26" or "07/31/2026"). Sheets are matched to categories by name — adjust below if needed.
          </p>
        </div>
        {!workbookSheets ? (
          <div className="max-w-lg">
            <FileUploadZone onParsed={(_r, file) => onWorkbookFile(file)} label="Drop a multi-sheet workbook here, or click to browse" />
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-w-xl border border-navy/20 rounded-lg p-4 bg-navy/[0.02]">
            <p className="text-[10px] font-mono text-inky/60 uppercase tracking-widest">Map each sheet</p>
            {workbookSheets.map((s) => {
              const monthCount = s.result.headers.slice(1).filter((h) => parsePivotMonth(h) !== null).length
              return (
                <div key={s.name} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-navy w-40 truncate" title={s.name}>{s.name}</span>
                  <span className="text-[10px] font-mono text-inky/50 w-20">{monthCount} mo</span>
                  <div className="flex-1">
                    <Select
                      options={[
                        { value: '', label: 'Total Ending Balance' },
                        ...categories.map((c) => ({ value: c.field_key, label: c.label })),
                        { value: SHEET_SKIP, label: '— Skip —' },
                      ]}
                      value={sheetTargets[s.name] ?? SHEET_SKIP}
                      onChange={(e) => setSheetTargets({ ...sheetTargets, [s.name]: e.target.value })}
                    />
                  </div>
                </div>
              )
            })}
            <div className="flex gap-2 pt-1">
              <Button size="sm" loading={workbookImporting} onClick={handleWorkbookImport}>Import Workbook</Button>
              <Button size="sm" variant="secondary" onClick={() => { setWorkbookSheets(null); setSheetTargets({}) }} disabled={workbookImporting}>Cancel</Button>
            </div>
          </div>
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

// Month-over-month rollup by category (Parts / Oil / Additives …). Sums each
// category across all locations per month and shows the change vs the prior month
// so wild swings in a category stand out.
function CategoryBalanceComparison({
  data, categories,
}: { data: MonthlyEndingBalance[]; categories: { field_key: string; label: string }[] }) {
  const rows = useMemo(() => {
    const byMonth = new Map<string, { total: number; cats: Record<string, number> }>()
    for (const r of data) {
      if (!r.month) continue
      const m = byMonth.get(r.month) ?? { total: 0, cats: {} }
      m.total += Number(r.ending_balance ?? 0)
      for (const c of categories) {
        const v = Number((r.metadata as any)?.[c.field_key])
        if (!isNaN(v)) m.cats[c.field_key] = (m.cats[c.field_key] ?? 0) + v
      }
      byMonth.set(r.month, m)
    }
    // Most recent month first
    return [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [data, categories])

  if (categories.length === 0 || rows.length === 0) return null

  // Delta cell vs the prior month (the next row in the desc-sorted list).
  function Delta({ curr, prev }: { curr: number; prev: number | undefined }) {
    if (prev === undefined || prev === 0) return null
    const d = curr - prev
    if (d === 0) return <span className="text-[10px] font-mono text-inky/40">—</span>
    const pct = (d / Math.abs(prev)) * 100
    const up = d > 0
    return (
      <span className={`text-[10px] font-mono ${up ? 'text-[#2ECC71]' : 'text-[#C0392B]'}`}>
        {up ? '▲' : '▼'} {fmt(Math.abs(d))} ({pct > 0 ? '+' : ''}{pct.toFixed(1)}%)
      </span>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Category Comparison — Month over Month</h3>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0">
            <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
              <th className="px-3 py-2 text-left">Month</th>
              {categories.map((c) => <th key={c.field_key} className="px-3 py-2 text-right">{c.label}</th>)}
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([month, agg], i) => {
              const prev = rows[i + 1]?.[1]
              let monthLabel = month
              try { monthLabel = format(new Date(month + 'T00:00:00'), 'MMM yyyy') } catch { /* keep raw */ }
              return (
                <tr key={month} className="border-b border-navy/20">
                  <td className="px-3 py-2 text-navy">{monthLabel}</td>
                  {categories.map((c) => {
                    const v = agg.cats[c.field_key] ?? 0
                    return (
                      <td key={c.field_key} className="px-3 py-2 text-right">
                        <div className="flex flex-col items-end leading-tight">
                          <span className="text-navy">{fmt(v)}</span>
                          <Delta curr={v} prev={prev?.cats[c.field_key]} />
                        </div>
                      </td>
                    )
                  })}
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-col items-end leading-tight">
                      <span className="text-navy font-bold">{fmt(agg.total)}</span>
                      <Delta curr={agg.total} prev={prev?.total} />
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
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
