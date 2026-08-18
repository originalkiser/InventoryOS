import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { type ImportMode } from '../useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { invalidateInventoryCache } from '@/hooks/useInventory'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { DataSourceLinker, type ExistingDataSource } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal, Combobox, Toggle } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import type { VisibilityState } from '@tanstack/react-table'
import { mappedValue } from '@/lib/columnTransform'
import { formatCurrency } from '@/lib/transforms'
import { formatUsage } from '@/lib/formatNumber'
import type { ProductUsage, ColumnMapping } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

export const EXCLUDE_NOT_IN_ORDER_KEY = 'product_usage.excludeNotInOrderConfig'

type DroptopMode = 'both' | 'inventory' | 'usage'

interface AlertThreshold {
  id: string
  product_id: string | null
  category: string | null
  max_adjustment: number
  enabled: boolean
}

interface InventoryAlert {
  id: string
  location_id: string | null
  product_id: string | null
  category: string | null
  change_type: string | null
  quantity_change: number | null
  event_timestamp: string | null
  acknowledged_at: string | null
  created_at: string
}

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
  if (d == null) return onHands != null && onHands > 0 ? '∞' : '—'
  return d.toFixed(1)
}

const REQUIRED_FIELDS = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'category', label: 'Category' },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'on_hands', label: 'On Hands' },
  { name: 'package_capacity', label: 'Package Capacity' },
  { name: 'cost_per_unit', label: 'Cost / Unit' },
]
// Same shape, but for files that only carry the vendor's own part number (e.g.
// a Valvoline usage export) — resolved to our_part_number via inventory.vendor_parts
// for the vendor picked below, instead of being mapped directly.
const REQUIRED_FIELDS_VENDOR_PART = [
  { name: 'location', label: 'Location', required: true },
  { name: 'vendor_part_number', label: "Vendor's Part Number", required: true },
  { name: 'category', label: 'Category' },
  { name: 'daily_usage', label: 'Daily Usage' },
  { name: 'on_hands', label: 'On Hands' },
  { name: 'package_capacity', label: 'Package Capacity' },
  { name: 'cost_per_unit', label: 'Cost / Unit' },
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
        {label} <span className="text-inky/50 ml-0.5">▾</span>
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
                  {allSelected ? '✓ All selected' : 'Select all'}
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
const EMPTY = { locationId: '', product_id: '', category: '', daily_usage: '', on_hands: '', package_capacity: '', cost_per_unit: '' }
// Columns not offered in the column manager (always shown, kept out of ordering).
const UNMANAGED_COLS = new Set(['edit'])

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
  const [dataSource, setDataSource] = useState<ExistingDataSource | null>(null)
  const [colsOpen, setColsOpen] = useState(false)

  // Vendor's-part-number import mode: resolve to our_part_number via
  // inventory.vendor_parts for the picked vendor, for files (like a Valvoline
  // usage export) that only carry the vendor's own part number.
  const [importMode, setImportMode] = useState<'product_id' | 'vendor_part'>('product_id')
  const [importVendorId, setImportVendorId] = useState('')
  const [vendors, setVendors] = useState<{ id: string; name: string }[]>([])
  const [vendorParts, setVendorParts] = useState<{ vendor_id: string | null; part_number: string | null; our_part_number: string | null }[]>([])
  // Package Capacity is sourced from the Global Config → Order Config table
  // (capacity per location + product), not from product_usage itself.
  const [capacityMap, setCapacityMap] = useState<Map<string, number>>(new Map())

  // Droptop sync
  const [droptopSyncing, setDroptopSyncing] = useState<DroptopMode | null>(null)
  const [droptopDaysBack, setDroptopDaysBack] = useState(30)
  const [droptopCategories, setDroptopCategories] = useState('Engine Oil, Additive')
  const [droptopLocationId, setDroptopLocationId] = useState<string>('')
  const [droptopResult, setDroptopResult] = useState<{ operations_synced: number; products_upserted: number } | null>(null)
  const [droptopError, setDroptopError] = useState<string | null>(null)

  const droptopLocations = useMemo(
    () => loc.locations.filter((l: any) => l.droptop_operation_id),
    [loc.locations],
  )

  // ---- Zero package-capacity filter ----
  const [excludeZeroPC, setExcludeZeroPC] = useAppSetting<boolean>('product_usage.excludeZeroPackageCapacity', true)
  const [includedZeroCats, setIncludedZeroCats] = useAppSetting<string[]>('product_usage.includedZeroCategories', [])

  const distinctCategories = useMemo(
    () => Array.from(new Set(data.map((r) => r.category || ''))).filter(Boolean).sort(),
    [data]
  )

  // Override each row's package_capacity with the Order Config capacity for the
  // same location + product; fall back to any value already on the row.
  const resolvedData = useMemo(() =>
    data.map((r) => {
      const cap = capacityMap.get(`${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}`)
      return cap != null ? { ...r, package_capacity: cap } : r
    }), [data, capacityMap])

  const displayData = useMemo(() => {
    if (!excludeZeroPC) return resolvedData
    return resolvedData.filter((r) => (r.package_capacity ?? 0) > 0 || includedZeroCats.includes(r.category ?? ''))
  }, [resolvedData, excludeZeroPC, includedZeroCats])

  const zeroExcludedCount = data.length - displayData.length

  // ---- Data loader ----
  // Direct paginated select instead of the get_product_usage RPC: a single
  // .range() is capped by PostgREST's db-max-rows (~1000). We count first, then
  // fetch all pages (6 at a time) so the whole table loads even at ~300k rows.
  const loadRpc = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const sb = supabase as any
    const PAGE = 1000, CONCURRENCY = 6
    const fetchPage = (p: number) => sb.schema('inventory').from('product_usage')
      .select('*').eq('company_id', profile.company_id)
      .order('id', { ascending: true }).range(p * PAGE, p * PAGE + PAGE - 1)
    const { count, error: cErr } = await sb.schema('inventory').from('product_usage')
      .select('id', { count: 'exact', head: true }).eq('company_id', profile.company_id)
    if (cErr) { toast.error('Product usage load failed'); setLoading(false); return }
    const total = count ?? 0
    const pages = Math.ceil(total / PAGE)
    const all: ProductUsage[] = []
    let failed = false
    for (let i = 0; i < pages && !failed; i += CONCURRENCY) {
      const group = Array.from({ length: Math.min(CONCURRENCY, pages - i) }, (_, j) => i + j)
      const results = await Promise.all(group.map((p) => fetchPage(p)))
      for (const { data: rows, error } of results) {
        if (error) { failed = true; break }
        for (const r of (rows ?? []) as ProductUsage[]) {
          all.push({ ...r, category: (String(r.category ?? '').trim() || null) })
        }
      }
    }
    if (failed) toast.error('Product usage load failed')
    else setData(all)
    setLoading(false)
  }, [profile?.company_id])

  const loadDataSource = useCallback(async () => {
    if (!profile?.company_id) return
    const { data: link } = await (supabase as any)
      .schema('inventory').from('data_source_links')
      .select('id, source_type, url, refresh_interval_minutes, last_synced_at, schedule_cron')
      .eq('company_id', profile.company_id)
      .eq('config_type', 'product_usage')
      .maybeSingle()
    setDataSource((link as ExistingDataSource) ?? null)
  }, [profile?.company_id])

  // Package Capacity comes from Order Config; page through it (1000/req) so the
  // map covers the whole table regardless of the server row cap.
  const loadCapacities = useCallback(async () => {
    if (!profile?.company_id) return
    const sb = supabase as any
    const PAGE = 1000
    let from = 0
    const m = new Map<string, number>()
    for (;;) {
      const { data: rows, error } = await sb
        .schema('inventory').from('location_order_config')
        .select('location_id, product_id, capacity').eq('company_id', profile.company_id)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) break
      const batch = (rows ?? []) as any[]
      for (const r of batch) {
        if (r.capacity == null) continue
        m.set(`${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}`, Number(r.capacity))
      }
      if (batch.length < PAGE) break
      from += PAGE
    }
    setCapacityMap(m)
  }, [profile?.company_id])

  // Vendors + vendor_parts for the vendor-part-number import mode below.
  const loadVendorParts = useCallback(async () => {
    if (!profile?.company_id) return
    const sb = supabase as any
    const [vRes] = await Promise.all([
      sb.schema('core').from('vendors').select('id, name').eq('company_id', profile.company_id),
    ])
    setVendors(((vRes.data ?? []) as any[]).map((v) => ({ id: v.id, name: v.name })))
    // Page through (server caps a single request at ~1000 rows) so a vendor
    // with parts past that cutoff still resolves — this is what silently
    // dropped every match for a vendor whose rows land later in the table.
    const PAGE = 1000
    let from = 0
    const all: { vendor_id: string | null; part_number: string | null; our_part_number: string | null }[] = []
    for (;;) {
      // vendor_parts lives in core (same schema VendorPartsTab reads/writes
      // it from), not inventory.
      const { data: rows, error } = await sb
        .schema('core').from('vendor_parts')
        .select('vendor_id, part_number, our_part_number').eq('company_id', profile.company_id)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) { toast.error('Unable to load Vendor Parts for the vendor-part-number import — ' + error.message); break }
      const batch = (rows ?? []) as any[]
      all.push(...batch)
      if (batch.length < PAGE) break
      from += PAGE
    }
    setVendorParts(all)
  }, [profile?.company_id])

  useEffect(() => { loadRpc(); loadDataSource(); loadCapacities(); loadVendorParts() }, [loadRpc, loadDataSource, loadCapacities, loadVendorParts])

  // vendorId|normalized part number -> our_part_number
  const vendorPartLookup = useMemo(() => {
    const m = new Map<string, string>()
    for (const vp of vendorParts) {
      if (!vp.vendor_id || !vp.part_number || !vp.our_part_number) continue
      m.set(`${vp.vendor_id}|${vp.part_number.toLowerCase().trim()}`, vp.our_part_number)
    }
    return m
  }, [vendorParts])
  const vendorOptions = useMemo(() => vendors.map((v) => ({ value: v.id, label: v.name })).sort((a, b) => a.label.localeCompare(b.label)), [vendors])

  async function clearAll() {
    if (!profile?.company_id) return
    const { error } = await (supabase as any).schema('inventory').from('product_usage').delete().eq('company_id', profile.company_id)
    if (error) { toast.error(error.message); return }
    toast.success('Table cleared')
    invalidateInventoryCache()
    await loadRpc()
  }

  // ---- Columns ----
  const columns = useMemo(() => [
    { id: 'location', header: 'Location', accessorFn: (r: ProductUsage) => loc.codeOf(r.location_id), cell: (i: any) => i.getValue() || '—' },
    col.accessor('product_id', { header: 'Product ID' }),
    col.accessor('category', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('daily_usage', { header: 'Daily Usage', cell: (i) => formatUsage(i.getValue()) }),
    col.accessor('on_hands', { header: 'On Hands', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('package_capacity', { header: 'Package Capacity', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('cost_per_unit', { header: 'Cost / Unit', cell: (i) => { const v = i.getValue(); return v == null ? '—' : formatCurrency(v) } }),
    { id: 'total_cost', header: 'Total Cost',
      accessorFn: (r: ProductUsage) => (r.cost_per_unit == null ? null : (r.on_hands ?? 0) * r.cost_per_unit),
      cell: (i: any) => { const v = i.getValue(); return v == null ? '—' : formatCurrency(v) } },
    col.accessor('days_of_supply', { header: 'Days of Supply', cell: (i) => { const r = i.row.original as ProductUsage; return dosDisplay(i.getValue(), r.on_hands) } }),
    col.accessor('updated_at', { header: 'Last Updated', cell: (i) => { const r = i.row.original as any; const s = r.last_change_source ? ` (${r.last_change_source})` : ''; return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—' } }),
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as ProductUsage)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
  ], [loc]) // eslint-disable-line react-hooks/exhaustive-deps

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(displayData, columns)
  useColumnPrefs('inventory.product_usage', table, columnVisibility, columnOrder, setColumnOrder)

  const colLabel = (c: ReturnType<typeof table.getAllLeafColumns>[number]) =>
    typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id

  const allColItems = useMemo<ColItem[]>(
    () => table.getAllLeafColumns().filter((c) => !UNMANAGED_COLS.has(c.id)).map((c) => ({ id: c.id, label: colLabel(c) })),
    [table, columnVisibility], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const shownOrder = useMemo(() => {
    const visible = table.getAllLeafColumns().filter((c) => !UNMANAGED_COLS.has(c.id) && c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return visible
    const rank = (id: string) => { const i = columnOrder.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i }
    return [...visible].sort((a, b) => rank(a) - rank(b))
  }, [table, columnOrder, columnVisibility]) // eslint-disable-line react-hooks/exhaustive-deps

  function applyShown(shown: string[]) {
    const shownSet = new Set(shown)
    const hidden = allColItems.map((c) => c.id).filter((id) => !shownSet.has(id))
    setColumnOrder([...shown, ...hidden])
    const vis: VisibilityState = {}
    for (const c of allColItems) vis[c.id] = shownSet.has(c.id)
    table.setColumnVisibility(vis)
  }

  function resetColumns() {
    setColumnOrder([])
    table.setColumnVisibility({})
  }

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
      cost_per_unit: r.cost_per_unit?.toString() ?? '',
    })
    setAddOpen(true)
  }

  // ---- Single-row mutations ----
  async function onSubmit() {
    if (!profile?.company_id || !form.product_id.trim()) return
    const du = parseNum(form.daily_usage), oh = parseNum(form.on_hands), pc = parseNum(form.package_capacity), cpu = parseNum(form.cost_per_unit)
    // Core columns (guaranteed to exist). cost_per_unit is saved best-effort
    // afterward so add/edit still works if the cost migration isn't applied yet.
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
    let savedId: string | null = editId
    if (editId) {
      ;({ error } = await sb.schema('inventory').from('product_usage').update(payload).eq('id', editId))
    } else {
      const res = await sb.schema('inventory').from('product_usage').insert(payload).select('id').single()
      error = res.error
      savedId = res.data?.id ?? null
    }
    if (error) { toast.error(error.message); return }
    // best-effort: cost_per_unit column may be pending migration
    if (savedId) sb.schema('inventory').from('product_usage').update({ cost_per_unit: cpu }).eq('id', savedId).then(() => {})
    toast.success(editId ? 'Updated' : 'Saved')
    resetForm(); setAddOpen(false); setEditId(null)
    invalidateInventoryCache()
    await loadRpc()
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this product-usage row?')) return
    const { error } = await (supabase as any).schema('inventory').from('product_usage').delete().eq('id', editId)
    if (error) { toast.error(error.message); return }
    toast.success('Deleted')
    resetForm(); setAddOpen(false); setEditId(null)
    invalidateInventoryCache()
    await loadRpc()
  }

  // ---- Droptop sync ----
  async function syncFromDroptop(mode: DroptopMode) {
    setDroptopSyncing(mode)
    setDroptopError(null)
    setDroptopResult(null)
    const { data, error } = await supabase.functions.invoke('droptop-sync-usage', {
      body: {
        mode,
        daysBack: droptopDaysBack,
        ...(droptopLocationId ? { locationId: droptopLocationId } : {}),
        categories: droptopCategories.split(',').map((c) => c.trim()).filter(Boolean),
      },
    })
    setDroptopSyncing(null)
    if (error) {
      setDroptopError(error.message)
      toast.error('Droptop sync failed')
      return
    }
    if (data?.error) {
      const msg = data.error === 'credentials_not_configured'
        ? 'Droptop API keys not configured — add DROPTOP_PUBLIC_KEY and DROPTOP_PRIVATE_KEY to Supabase secrets.'
        : data.error
      setDroptopError(msg)
      toast.error('Droptop sync failed')
      return
    }
    setDroptopResult({
      operations_synced: data.operations_synced ?? 0,
      products_upserted: data.products_upserted ?? 0,
    })
    toast.success(`Synced ${(data.products_upserted ?? 0).toLocaleString()} products from Droptop`)
    invalidateInventoryCache()
    loadRpc()
  }

  // ---- Batch import ----
  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    if (!profile?.company_id) return
    const usesVendorPart = maps.some((m) => m.fieldName === 'vendor_part_number')
    if (usesVendorPart && !importVendorId) { toast.error('Pick which vendor these part numbers belong to'); return }
    setImporting(true)
    const sb = supabase as any
    // Only send cost_per_unit when the file actually maps it, so imports without
    // a cost column still work if the cost migration isn't applied yet.
    const hasCost = maps.some((m) => m.fieldName === 'cost_per_unit')

    let unresolved = 0
    const payload = rows.map((row) => {
      let location_id: string | null = null
      let product_id = '', category: string | null = null
      let daily_usage: number | null = null, on_hands: number | null = null, package_capacity: number | null = null, cost_per_unit: number | null = null
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        if (m.fieldName === 'location') location_id = loc.resolveId(v)
        else if (m.fieldName === 'product_id') product_id = v
        else if (m.fieldName === 'vendor_part_number') {
          const resolved = v.trim() ? vendorPartLookup.get(`${importVendorId}|${v.toLowerCase().trim()}`) : undefined
          if (resolved) product_id = resolved
          else if (v.trim()) unresolved++
        }
        else if (m.fieldName === 'category') category = v.trim() || null
        else if (m.fieldName === 'daily_usage') daily_usage = parseNum(v)
        else if (m.fieldName === 'on_hands') on_hands = parseNum(v)
        else if (m.fieldName === 'package_capacity') package_capacity = parseNum(v)
        else if (m.fieldName === 'cost_per_unit') cost_per_unit = parseNum(v)
      }
      return { location_id, product_id, category, daily_usage, on_hands, package_capacity, days_of_supply: daysOfSupply(on_hands, daily_usage), ...(hasCost ? { cost_per_unit } : {}) }
    }).filter((r) => r.product_id)

    if (unresolved > 0) toast.error(`${unresolved.toLocaleString()} row(s) skipped — vendor part number not found in Vendor Parts for that vendor`)

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
    invalidateInventoryCache()
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
            ? <>Zero package capacity hidden{zeroExcludedCount > 0 && <span className="text-orange-600"> · {zeroExcludedCount.toLocaleString()} hidden</span>}</>
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
            <span className="text-navy/30 text-xs">·</span>
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
        hideColumnControl
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            <Toggle checked={exclude} onChange={setExclude} size="sm" color="amber" />
            Exclude products not in order config
          </label>
          <Button size="sm" variant="secondary" onClick={() => setColsOpen(true)}>Columns</Button>
          <Button size="sm" onClick={openAdd}>+ Add Row</Button>
        </>}
      />

      <ColumnManagerModal
        open={colsOpen}
        onClose={() => setColsOpen(false)}
        all={allColItems}
        shown={shownOrder}
        onChange={applyShown}
        onReset={resetColumns}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload File</h3>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono text-inky">File identifies products by</span>
            <div className="flex rounded border border-navy/30 overflow-hidden">
              <button onClick={() => setImportMode('product_id')}
                className={`px-2.5 py-1 text-xs font-mono ${importMode === 'product_id' ? 'bg-sky/20 text-navy font-bold' : 'text-inky hover:text-navy'}`}>
                Our Product ID
              </button>
              <button onClick={() => setImportMode('vendor_part')}
                className={`px-2.5 py-1 text-xs font-mono ${importMode === 'vendor_part' ? 'bg-sky/20 text-navy font-bold' : 'text-inky hover:text-navy'}`}>
                Vendor's Part Number
              </button>
            </div>
          </div>
          {importMode === 'vendor_part' && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-inky uppercase tracking-wide">Vendor</span>
              <div className="w-56"><Combobox options={vendorOptions} value={importVendorId} onChange={setImportVendorId} placeholder="Select vendor…" /></div>
              <span className="text-[10px] font-mono text-inky/50">resolved via Vendor Parts (part number → our_part_number)</span>
            </div>
          )}
          <ConfigUpload requiredFields={importMode === 'vendor_part' ? REQUIRED_FIELDS_VENDOR_PART : REQUIRED_FIELDS} onImport={handleImport} importing={importing} />
        </div>
        <DataSourceLinker
          configType="product_usage"
          existingLink={dataSource}
          requiredFields={REQUIRED_FIELDS}
          onImport={handleImport}
          onSaved={loadDataSource}
        />
      </div>

      {/* ── Droptop Sync ──────────────────────────────────────────────────── */}
      <div className="border-t border-navy/10 pt-4">
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Droptop Sync</h3>
            <p className="text-xs text-inky/60 mt-0.5">
              Pull on-hands and sales usage directly from Droptop. Requires <code className="font-mono bg-navy/5 px-1 rounded">DROPTOP_PUBLIC_KEY</code> and <code className="font-mono bg-navy/5 px-1 rounded">DROPTOP_PRIVATE_KEY</code> in Supabase secrets, and a Droptop Operation ID set on each location (edit a location → Integrations tab).
            </p>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            {droptopLocations.length > 0 && (
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Location</span>
                <select
                  value={droptopLocationId}
                  onChange={(e) => setDroptopLocationId(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]"
                >
                  <option value="">All locations ({droptopLocations.length})</option>
                  {droptopLocations.map((l: any) => (
                    <option key={l.id} value={l.id}>{l.name || l.shop_city || l.id}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Usage window (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={droptopDaysBack}
                onChange={(e) => setDroptopDaysBack(Math.min(Math.max(Number(e.target.value) || 1, 1), 365))}
                className="w-24 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Categories (comma-separated, blank = all)</span>
              <input
                type="text"
                value={droptopCategories}
                onChange={(e) => setDroptopCategories(e.target.value)}
                placeholder="All categories"
                className="w-56 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]"
              />
            </label>
            <Button size="sm" onClick={() => syncFromDroptop('both')} disabled={droptopSyncing != null}>
              {droptopSyncing === 'both' ? 'Syncing…' : 'Full Sync'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => syncFromDroptop('inventory')} disabled={droptopSyncing != null}>
              {droptopSyncing === 'inventory' ? 'Syncing…' : 'On-Hands Only'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => syncFromDroptop('usage')} disabled={droptopSyncing != null}>
              {droptopSyncing === 'usage' ? 'Syncing…' : 'Usage Only'}
            </Button>
          </div>
          <p className="text-[10px] font-mono text-inky/50">
            On-Hands Only = 1 API call per location (cheap, schedule daily). Usage Only pages through change events for the window (heavier — run less often). Partial syncs keep the other side's existing values.
          </p>
          {droptopResult && (
            <p className="text-xs font-mono text-inky">
              Synced {droptopResult.operations_synced} location{droptopResult.operations_synced !== 1 ? 's' : ''} · {droptopResult.products_upserted.toLocaleString()} products updated
            </p>
          )}
          {droptopError && (
            <p className="text-xs font-mono text-[#C0392B]">{droptopError}</p>
          )}
        </div>
      </div>

      <InventoryAlertsSection locationLabel={(id) => loc.labelOf(id)} />

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Product Usage' : 'Add Product Usage'} size="lg">
        <div className="flex flex-col gap-3">
          <Combobox label="Location" options={loc.options} value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} placeholder="Select location" />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Product ID *" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })} />
            <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <Input label="Daily Usage" type="number" step="0.01" value={form.daily_usage} onChange={(e) => setForm({ ...form, daily_usage: e.target.value })} />
            <Input label="On Hands" type="number" step="0.01" value={form.on_hands} onChange={(e) => setForm({ ...form, on_hands: e.target.value })} />
            <Input label="Package Capacity" type="number" step="0.01" value={form.package_capacity} onChange={(e) => setForm({ ...form, package_capacity: e.target.value })} />
            <Input label="Cost / Unit" type="number" step="0.01" value={form.cost_per_unit} onChange={(e) => setForm({ ...form, cost_per_unit: e.target.value })} />
          </div>
          <div className="flex items-center gap-6">
            <p className="text-xs font-mono text-inky">Days of Supply: <span className="text-inky">{dosDisplay(daysOfSupply(parseNum(form.on_hands), parseNum(form.daily_usage)), parseNum(form.on_hands))}</span></p>
            {parseNum(form.cost_per_unit) != null && (
              <p className="text-xs font-mono text-inky">Total Cost: <span className="text-navy">{formatCurrency((parseNum(form.on_hands) ?? 0) * (parseNum(form.cost_per_unit) ?? 0))}</span></p>
            )}
          </div>
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

// ---------------------------------------------------------------------------
// Inventory activity alerts: threshold rules by product ID / category, and the
// alerts raised when Droptop adjustment events exceed a rule.
// Requires migration 20260710_inventory_alerts.sql.
function InventoryAlertsSection({ locationLabel }: { locationLabel: (id: string | null) => string }) {
  const { profile } = useAuthStore()
  const sb = supabase as any

  const [rules, setRules] = useState<AlertThreshold[]>([])
  const [alerts, setAlerts] = useState<InventoryAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [newRule, setNewRule] = useState({ product_id: '', category: '', max_adjustment: '' })
  const [scanDays, setScanDays] = useState(1)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const [r, a] = await Promise.all([
      sb.schema('inventory').from('alert_thresholds')
        .select('id, product_id, category, max_adjustment, enabled')
        .eq('company_id', profile.company_id).order('created_at'),
      sb.schema('inventory').from('inventory_alerts')
        .select('id, location_id, product_id, category, change_type, quantity_change, event_timestamp, acknowledged_at, created_at')
        .eq('company_id', profile.company_id).is('acknowledged_at', null)
        .order('created_at', { ascending: false }).limit(100),
    ])
    if (r.error) {
      setLoadError('Alert tables not found — apply migration 20260710_inventory_alerts.sql')
    } else {
      setRules((r.data ?? []) as AlertThreshold[])
      setAlerts((a.data ?? []) as InventoryAlert[])
      setLoadError(null)
    }
    setLoading(false)
  }, [profile?.company_id])

  useEffect(() => { load() }, [load])

  async function addRule() {
    if (!profile?.company_id) return
    const max = Number(newRule.max_adjustment)
    if (!newRule.product_id.trim() && !newRule.category.trim()) {
      toast.error('Enter a product ID and/or category')
      return
    }
    if (!max || max <= 0) {
      toast.error('Enter a max adjustment greater than 0')
      return
    }
    const { error } = await sb.schema('inventory').from('alert_thresholds').insert({
      company_id: profile.company_id,
      product_id: newRule.product_id.trim() || null,
      category: newRule.category.trim() || null,
      max_adjustment: max,
      updated_by: profile.id,
      last_change_source: 'manual',
    })
    if (error) { toast.error('Unable to save rule'); return }
    setNewRule({ product_id: '', category: '', max_adjustment: '' })
    toast.success('Rule added')
    load()
  }

  async function toggleRule(rule: AlertThreshold) {
    const { error } = await sb.schema('inventory').from('alert_thresholds')
      .update({ enabled: !rule.enabled, updated_at: new Date().toISOString(), updated_by: profile?.id })
      .eq('id', rule.id)
    if (error) { toast.error('Unable to update rule'); return }
    load()
  }

  async function deleteRule(id: string) {
    const { error } = await sb.schema('inventory').from('alert_thresholds').delete().eq('id', id)
    if (error) { toast.error('Unable to delete rule'); return }
    load()
  }

  async function acknowledgeAlert(id: string) {
    const { error } = await sb.schema('inventory').from('inventory_alerts')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: profile?.id })
      .eq('id', id)
    if (error) { toast.error('Unable to acknowledge'); return }
    setAlerts((prev) => prev.filter((a) => a.id !== id))
  }

  async function scanActivity() {
    setScanning(true)
    setScanError(null)
    setScanResult(null)
    const { data, error } = await supabase.functions.invoke('droptop-sync-usage', {
      body: { mode: 'alerts', daysBack: scanDays },
    })
    setScanning(false)
    if (error) { setScanError(error.message); toast.error('Alert scan failed'); return }
    if (data?.error) { setScanError(data.error); toast.error('Alert scan failed'); return }
    const n = data.alerts_created ?? 0
    setScanResult(`Scanned ${data.operations_synced ?? 0} locations - ${n} new alert${n !== 1 ? 's' : ''}`)
    if (n > 0) toast.success(`${n} new inventory alert${n !== 1 ? 's' : ''}`)
    else toast.success('No unusual activity found')
    load()
  }

  return (
    <div className="border-t border-navy/10 pt-4">
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Inventory Alerts</h3>
          <p className="text-xs text-inky/60 mt-0.5">
            Flag unusual Droptop adjustment activity. A rule matches by product ID (exact) and/or category (contains); an alert fires when an adjustment event meets or exceeds the max quantity.
          </p>
        </div>

        {loading && <p className="text-xs font-mono text-inky/60">Loading alert rules…</p>}
        {loadError && <p className="text-xs font-mono text-[#C0392B]">{loadError}</p>}

        {!loading && !loadError && (
          <>
            {/* Rules */}
            <div className="flex flex-col gap-1.5">
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-3 text-xs font-mono">
                  <Toggle checked={r.enabled} onChange={() => toggleRule(r)} />
                  <span className={r.enabled ? 'text-navy dark:text-cream' : 'text-inky/50'}>
                    {r.product_id ? `Product ${r.product_id}` : ''}
                    {r.product_id && r.category ? ' + ' : ''}
                    {r.category ? `Category "${r.category}"` : ''}
                    {' — adjustment ≥ '}{r.max_adjustment}
                  </span>
                  <button onClick={() => deleteRule(r.id)} className="text-inky/50 hover:text-[#C0392B] text-[10px] uppercase">Delete</button>
                </div>
              ))}
              {rules.length === 0 && <p className="text-xs font-mono text-inky/50">No rules yet.</p>}
              <div className="flex items-end gap-2 flex-wrap mt-1">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Product ID</span>
                  <input type="text" value={newRule.product_id} onChange={(e) => setNewRule({ ...newRule, product_id: e.target.value })}
                    placeholder="Any product"
                    className="w-36 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Category contains</span>
                  <input type="text" value={newRule.category} onChange={(e) => setNewRule({ ...newRule, category: e.target.value })}
                    placeholder="Any category"
                    className="w-36 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Max adjustment qty</span>
                  <input type="number" min={0} step="0.01" value={newRule.max_adjustment} onChange={(e) => setNewRule({ ...newRule, max_adjustment: e.target.value })}
                    className="w-28 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]" />
                </label>
                <Button size="sm" variant="secondary" onClick={addRule}>Add Rule</Button>
              </div>
            </div>

            {/* Scan */}
            <div className="flex items-end gap-3 flex-wrap">
              <label className="flex flex-col gap-0.5">
                <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Scan window (days)</span>
                <input type="number" min={1} max={365} value={scanDays}
                  onChange={(e) => setScanDays(Math.min(Math.max(Number(e.target.value) || 1, 1), 365))}
                  className="w-24 rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none dark:bg-[#0e2638]" />
              </label>
              <Button size="sm" onClick={scanActivity} disabled={scanning || rules.filter((r) => r.enabled).length === 0}>
                {scanning ? 'Scanning…' : 'Scan Activity'}
              </Button>
            </div>
            {scanResult && <p className="text-xs font-mono text-inky">{scanResult}</p>}
            {scanError && <p className="text-xs font-mono text-[#C0392B]">{scanError}</p>}

            {/* Open alerts */}
            {alerts.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Open alerts ({alerts.length})</span>
                <div className="max-h-64 overflow-y-auto flex flex-col gap-0.5">
                  {alerts.map((a) => (
                    <div key={a.id} className="flex items-center gap-3 text-xs font-mono bg-[#E67E22]/10 border border-[#E67E22]/30 rounded px-2 py-1">
                      <span className="text-navy dark:text-cream">
                        {locationLabel(a.location_id)} · {a.product_id} · {a.change_type} {a.quantity_change}
                        {a.event_timestamp ? ` · ${format(new Date(a.event_timestamp), 'MMM d h:mm a')}` : ''}
                      </span>
                      <button onClick={() => acknowledgeAlert(a.id)} className="ml-auto text-inky/60 hover:text-navy text-[10px] uppercase shrink-0">Acknowledge</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
