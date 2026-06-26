import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ProductUsage, ColumnMapping } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

export const EXCLUDE_NOT_IN_ORDER_KEY = 'product_usage.excludeNotInOrderConfig'

function parseNum(v: string): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t.replace(/[$,]/g, ''))
  return isNaN(n) ? null : n
}

export function daysOfSupply(onHands: number | null, dailyUsage: number | null): number | null {
  if (dailyUsage == null || dailyUsage <= 0) return null
  if (onHands == null) return null
  return onHands / dailyUsage
}

function dosDisplay(d: number | null, onHands: number | null): string {
  if (d == null) return onHands != null && onHands > 0 ? 'âˆž' : 'â€”'
  return d.toFixed(1)
}

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'category', label: 'Category' },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'on_hands', label: 'On Hands' },
  { name: 'package_capacity', label: 'Package Capacity' },
]

const BATCH = 2000
const CONCURRENCY = 4

async function writeInBatches(rows: Record<string, unknown>[]): Promise<string | null> {
  const sb = supabase as any
  const batches: Record<string, unknown>[][] = []
  for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH))
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const results = await Promise.all(
      batches.slice(i, i + CONCURRENCY).map((slice) => sb.schema('inventory').from('product_usage').upsert(slice))
    )
    for (const { error } of results) { if (error) return error.message }
  }
  return null
}

// ---------------------------------------------------------------------------
function CategoryDropdown({
  categories,
  selected,
  onChange,
}: {
  categories: string[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  function toggle(cat: string) {
    onChange(selected.includes(cat) ? selected.filter((c) => c !== cat) : [...selected, cat])
  }
  const allSelected = categories.length > 0 && selected.length === categories.length
  const label =
    selected.length === 0
      ? 'none'
      : `${selected.length} categor${selected.length === 1 ? 'y' : 'ies'}`

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded border border-navy/30 px-2 py-0.5 text-xs font-mono text-navy hover:border-navy"
      >
        {label} <span className="text-inky/50 ml-0.5">â–¾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 top-full mt-1 left-0 min-w-[200px] max-h-64 overflow-auto rounded border border-navy/30 bg-cream shadow-xl py-1">
            {categories.length === 0 ? (
              <p className="px-3 py-2 text-xs font-body italic text-inky/60">No categories in data yet</p>
            ) : (
              <>
                <button
                  onClick={() => onChange(allSelected ? [] : [...categories])}
                  className="w-full px-3 py-1.5 text-left text-xs font-body text-inky hover:bg-navy/5"
                >
                  {allSelected ? 'âœ“ All selected' : 'Select all'}
                </button>
                <div className="border-t border-navy/10 mt-1 pt-1">
                  {categories.map((cat) => (
                    <label key={cat} className="flex items-center gap-2 px-3 py-1.5 hover:bg-navy/5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.includes(cat)}
                        onChange={() => toggle(cat)}
                        className="accent-inky"
                      />
                      <span className="text-xs font-body text-navy">{cat || '(Uncategorized)'}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
const col = createColumnHelper<ProductUsage>()
const EMPTY = { locationId: '', product_id: '', category: '', daily_usage: '', on_hands: '', package_capacity: '' }

export function ProductUsageTab() {
  const { profile } = useAuthStore()
  const loc = useLocations()

  const [data, setData] = useState<ProductUsage[]>([])
  const [loading, setLoading] = useState(true)
  const [exclude, setExclude] = useAppSetting<boolean>(EXCLUDE_NOT_IN_ORDER_KEY, false)
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY })

  // ---- Zero package-capacity filter ----
  const [excludeZeroPC, setExcludeZeroPC] = useAppSetting<boolean>('product_usage.excludeZeroPackageCapacity', true)
  const [includedZeroCats, setIncludedZeroCats] = useAppSetting<string[]>('product_usage.includedZeroCategories', [])

  const distinctCategories = useMemo(
    () => Array.from(new Set(data.map((r) => r.category || ''))).filter(Boolean).sort(),
    [data]
  )

  const displayData = useMemo(() => {
    if (!excludeZeroPC) return data
    return data.filter((r) => (r.package_capacity ?? 0) > 0 || includedZeroCats.includes(r.category ?? ''))
  }, [data, excludeZeroPC, includedZeroCats])

  const zeroExcludedCount = data.length - displayData.length

  // ---- RPC data loader ----
  const loadRpc = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const { data: rows, error } = await (supabase as any)
      .rpc('get_product_usage', { p_company_id: profile.company_id })
      .range(0, 99999)
    if (error) toast.error('Product usage load failed â€” run the latest DB migration')
    else setData((rows ?? []) as ProductUsage[])
    setLoading(false)
  }, [profile?.company_id])

  useEffect(() => { loadRpc() }, [loadRpc])

  async function clearAll() {
    if (!profile?.company_id) return
    const { error } = await (supabase as any).schema('inventory').from('product_usage').delete().eq('company_id', profile.company_id)
    if (error) { toast.error(error.message); return }
    toast.success('Table cleared')
    await loadRpc()
  }

  // ---- Columns ----
  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: ProductUsage) => loc.codeOf(r.location_id), cell: (i: any) => i.getValue() || 'â€”' },
    col.accessor('product_id', { header: 'Product ID' }),
    col.accessor('category', { header: 'Category', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('daily_usage', { header: 'Daily Usage', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('on_hands', { header: 'On Hands', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('package_capacity', { header: 'Package Capacity', cell: (i) => i.getValue() ?? 'â€”' }),
    col.accessor('days_of_supply', { header: 'Days of Supply', cell: (i) => { const r = i.row.original as ProductUsage; return dosDisplay(i.getValue(), r.on_hands) } }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : 'â€”' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as ProductUsage)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ], [loc]) // eslint-disable-line react-hooks/exhaustive-deps

  const { table, globalFilter, setGlobalFilter } = useTable(displayData, columns)

  // ---- Form helpers ----
  function resetForm() { setForm({ ...EMPTY }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: ProductUsage) {
    setEditId(r.id)
    setForm({
      locationId: r.location_id ?? '',
      product_id: r.product_id ?? '',
      category: r.category ?? '',
      daily_usage: r.daily_usage?.toString() ?? '',
      on_hands: r.on_hands?.toString() ?? '',
      package_capacity: r.package_capacity?.toString() ?? '',
    })
    setAddOpen(true)
  }

  // ---- Single-row mutations ----
  async function onSubmit() {
    if (!profile?.company_id || !form.product_id.trim()) return
    const du = parseNum(form.daily_usage), oh = parseNum(form.on_hands), pc = parseNum(form.package_capacity)
    const payload: Record<string, unknown> = {
      company_id: profile.company_id,
      location_id: form.locationId || null,
      product_id: form.product_id.trim(),
      category: form.category.trim() || null,
      daily_usage: du,
      on_hands: oh,
      package_capacity: pc,
      days_of_supply: daysOfSupply(oh, du),
      updated_by: profile.id ?? null,
      last_change_source: 'manual',
    }
    const sb = supabase as any
    let error: { message: string } | null
    if (editId) {
      ;({ error } = await sb.schema('inventory').from('product_usage').update(payload).eq('id', editId))
    } else {
      ;({ error } = await sb.schema('inventory').from('product_usage').insert(payload))
    }
    if (error) { toast.error(error.message); return }
    toast.success(editId ? 'Updated' : 'Saved')
    resetForm(); setAddOpen(false); setEditId(null)
    await loadRpc()
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this product-usage row?')) return
    const { error } = await (supabase as any).schema('inventory').from('product_usage').delete().eq('id', editId)
    if (error) { toast.error(error.message); return }
    toast.success('Deleted')
    resetForm(); setAddOpen(false); setEditId(null)
    await loadRpc()
  }

  // ---- Batch import ----
  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    if (!profile?.company_id) return
    setImporting(true)
    const sb = supabase as any

    const payload = rows.map((row) => {
      let location_id: string | null = null
      let product_id = '', category: string | null = null
      let daily_usage: number | null = null, on_hands: number | null = null, package_capacity: number | null = null
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product_id') product_id = v
        else if (m.fieldName === 'category') category = v.trim() || null
        else if (m.fieldName === 'daily_usage') daily_usage = parseNum(v)
        else if (m.fieldName === 'on_hands') on_hands = parseNum(v)
        else if (m.fieldName === 'package_capacity') package_capacity = parseNum(v)
      }
      return { location_id, product_id, category, daily_usage, on_hands, package_capacity, days_of_supply: daysOfSupply(on_hands, daily_usage) }
    }).filter((r) => r.product_id)

    if (mode === 'replace') {
      const { error: delErr } = await sb.schema('inventory').from('product_usage').delete().eq('company_id', profile.company_id)
      if (delErr) { toast.error(delErr.message); setImporting(false); return }
      const stamped = payload.map((r) => ({ ...r, company_id: profile.company_id, updated_by: profile.id ?? null, last_change_source: 'upload' }))
      const err = await writeInBatches(stamped)
      if (err) { toast.error(err); setImporting(false); return }
      toast.success(`Replaced with ${payload.length.toLocaleString()} rows`)
    } else {
      // Merge: match existing by (location_id, product_id) and attach their id so upsert updates in-place
      const existingByKey = new Map<string, string>()
      for (const d of data) {
        const k = `${d.location_id ?? ''}|${String(d.product_id).toLowerCase()}`
        if (d.id) existingByKey.set(k, d.id)
      }
      const stamped = payload.map((r) => {
        const k = `${r.location_id ?? ''}|${String(r.product_id).toLowerCase()}`
        const existingId = existingByKey.get(k)
        return { ...r, company_id: profile.company_id, updated_by: profile.id ?? null, last_change_source: 'upload', ...(existingId ? { id: existingId } : {}) }
      })
      const err = await writeInBatches(stamped)
      if (err) { toast.error(err); setImporting(false); return }
      const updated = stamped.filter((r: any) => r.id).length
      toast.success(`Imported ${stamped.length.toLocaleString()} rows (${updated.toLocaleString()} updated, ${(stamped.length - updated).toLocaleString()} new)`)
    }

    setImporting(false)
    loadRpc().catch(() => {})
  }

  // ---- Render ----
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Product Usage</h2>
        <p className="text-xs text-inky mt-0.5">Daily usage, on-hands, and days of supply by location. Use a Divide transform on Daily Usage to convert a period total to a daily figure.</p>
      </div>

      {/* Zero package-capacity filter banner */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-navy/20 bg-cream px-3 py-2">
        <span className="text-xs font-mono text-inky">
          {excludeZeroPC
            ? <>Zero package capacity hidden{zeroExcludedCount > 0 && <span className="text-orange-600"> Â· {zeroExcludedCount.toLocaleString()} hidden</span>}</>
            : 'Showing all products'}
        </span>
        <button
          onClick={() => setExcludeZeroPC(!excludeZeroPC)}
          className="text-xs font-mono text-inky/60 hover:text-navy underline"
        >
          {excludeZeroPC ? 'show all' : 'hide zero package capacity'}
        </button>
        {excludeZeroPC && (
          <>
            <span className="text-navy/30 text-xs">Â·</span>
            <span className="text-xs font-mono text-inky">include by category:</span>
            <CategoryDropdown
              categories={distinctCategories}
              selected={includedZeroCats}
              onChange={setIncludedZeroCats}
            />
          </>
        )}
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="product_usage.csv"
        exportData={displayData}
        loading={loading}
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={exclude} onChange={setExclude} size="sm" color="amber" />
            Exclude products not in order config
          </label>
          <Button size="sm" onClick={openAdd}>+ Add Row</Button>
        </>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <ConfigUpload requiredFields={REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker configType="product_usage" />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Product Usage' : 'Add Product Usage'} size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Location" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <Input label="Daily Usage" type="number" step="0.01" value={form.daily_usage} onChange={(e) => setForm({ ...form, daily_usage: e.target.value })} />
            <Input label="On Hands" type="number" step="0.01" value={form.on_hands} onChange={(e) => setForm({ ...form, on_hands: e.target.value })} />
            <Input label="Package Capacity" type="number" step="0.01" value={form.package_capacity} onChange={(e) => setForm({ ...form, package_capacity: e.target.value })} />
          </div>
          <p className="text-xs font-mono text-inky">Days of Supply: <span className="text-inky">{dosDisplay(daysOfSupply(parseNum(form.on_hands), parseNum(form.daily_usage)), parseNum(form.on_hands))}</span></p>
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
