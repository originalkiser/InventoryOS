// Droptop Orders explorer — searchable/filterable table of synced orders
// (inventory.droptop_orders + its package/product/service line items),
// plus a summary section of high-level stats. Complements the Customer
// Heatmap (same underlying data, different lens: this is about what got
// sold, not where customers came from).
//
// "Average oil quarts by package" specifically needs the services table
// (inventory.droptop_order_services), not the top-level products table —
// only services links a consumed product back to the package it was used
// to perform. A product is treated as "oil" here by unit of measure (QT)
// rather than by name/category text, matching this app's existing
// quart-based convention for oil products (see orders-v2's engine).
//
// The product-id filter checks BOTH inventory.droptop_order_products (the
// top-level products array) AND droptop_order_services' nested products —
// an earlier version only checked the former, which is why product-id
// search kept coming up empty: most consumed products (oil, filters, etc.)
// only ever show up inside services, not the flat top-level array.
import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useEarliestOrderDate } from '@/hooks/useEarliestOrderDate'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { Button, Card, CardBody, Input, MultiSelectDropdown } from '@/components/ui'

interface OrderRow {
  id: string
  location_id: string | null
  order_id: string
  first_name: string | null
  last_name: string | null
  city: string | null
  region: string | null
  status: string | null
  subtotal: number | null
  final_price: number | null
  order_finalized_at: string | null
}
interface PackageRow {
  order_id: string
  package_id: string | null
  name: string | null
  price_total: number | null
  price_total_after_discount: number | null
}
interface ProductRow {
  order_id: string
  product_id: string | null
  product_type: string | null
  uom: string | null
  quantity_total: number | null
}
interface ServiceRow {
  order_id: string
  package_id: string | null
  products: { product_id?: string; uom?: string; quantity_total?: string | number }[] | null
}

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const isQuart = (uom: string | null | undefined) => (uom ?? '').trim().toUpperCase() === 'QT'
const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

// Fetch rows for a batch of order ids, chunking the input AND paginating
// each chunk's output. CHUNK alone isn't enough — this project's Supabase
// "Max Rows" API setting silently caps every response at 1000 regardless
// of .limit(), and a chunk of order ids can produce more result rows than
// input ids (an order can have multiple packages/products/services), so
// an unpaginated .in() could silently drop rows past 1000 with no error.
// Same fix as the main orders loop: keep fetching by (id) cursor per
// chunk until a genuinely empty page.
async function fetchByOrderIds<T>(table: string, orderIds: string[], select: string): Promise<T[]> {
  const sb = supabase as any
  const CHUNK = 200
  const PAGE = 1000
  const MAX_PAGE_RETRIES = 2
  const out: T[] = []
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const slice = orderIds.slice(i, i + CHUNK)
    let cursor: string | null = null
    for (;;) {
      let data: ({ id: string } & T)[] | null = null
      let lastErr: string | null = null
      for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
        let q = sb.schema('inventory').from(table).select(`id, ${select}`)
          .in('order_id', slice).order('id', { ascending: true }).limit(PAGE)
        if (cursor) q = q.gt('id', cursor)
        const { data: pageData, error } = await q
        if (!error) { data = (pageData ?? []) as ({ id: string } & T)[]; break }
        lastErr = error.message
        if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
      // Same "retry a page before giving up" fix as the main orders loop
      // above — a single chunk/page timing out used to throw immediately
      // and discard every package/product/service row fetched so far.
      if (data === null) throw new Error(`${table}: ${lastErr ?? 'Failed to load'}`)
      out.push(...data)
      if (data.length === 0) break
      cursor = data[data.length - 1].id
    }
  }
  return out
}

export function DroptopOrdersPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — franchise shops included by default here (unlike
  // Inventory-side pages), per explicit product decision 2026-09-01.
  const loc = useLocations('other')
  const earliestDate = useEarliestOrderDate(companyId)
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod('droptop-orders:period', 'last_week')

  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [loadAllShops, setLoadAllShops] = useState(false)
  const [packageFilters, setPackageFilters] = useState<string[]>([])
  const [productIdFilter, setProductIdFilter] = useState('')
  const [search, setSearch] = useState('')
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [packages, setPackages] = useState<PackageRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [services, setServices] = useState<ServiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Real progress instead of a bare spinner — same pattern as Customer
  // Heatmap's full-detail load: a cheap COUNT-only request up front gives
  // a denominator, `loaded` ticks up per page.
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const idToLabel = useMemo(() => new Map(loc.includedOptions.map((o) => [o.value, o.label])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

  // Region/Market/AM — same shape as Customer Heatmap's pin filters, but
  // here they narrow the SELECTED shops (whichever the query already
  // scoped to, via Shop(s) or Load All), not a separate pin layer. null =
  // no restriction.
  const regionOptions = useMemo(
    () => [...new Set(loc.locations.map((l) => l.region ?? '').filter(Boolean))].sort().map((v) => ({ value: v })),
    [loc.locations],
  )
  const marketOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions])
  const amOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    if (filterMarkets.length) r = r.filter((l) => filterMarkets.includes(loc.fieldValue(l.id, 'market')))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'area_manager')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets])
  const allowedLocationIds = useMemo(() => {
    if (!filterRegions.length && !filterMarkets.length && !filterAMs.length) return null
    const ids = new Set<string>()
    for (const l of loc.locations) {
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) continue
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) continue
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) continue
      ids.add(l.id)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets, filterAMs])

  useEffect(() => {
    if (!companyId) return
    // Require at least one shop OR an explicit "load all" opt-in — an
    // unscoped company-wide pull for a date range is the slow/laggy path
    // this gate exists to avoid by default, but it's still available on
    // request rather than blocked outright.
    if (!shopIds.length && !loadAllShops) {
      setOrders([]); setPackages([]); setProducts([]); setServices([])
      setLoading(false); setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setLoadProgress({ loaded: 0, total: null })
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`

    function applyFilters(q: any) {
      q = q.eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
      if (shopIds.length) q = q.in('location_id', shopIds)
      return q
    }

    async function run() {
      // Real progress instead of an indeterminate spinner: a cheap
      // COUNT-only request (head:true — no rows returned, the count is
      // computed server-side) using the exact same filters as the real
      // fetch below. Best-effort — if it fails for any reason the load
      // still proceeds, just without a percentage.
      const { count } = await applyFilters(sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true }))
      if (!cancelled) setLoadProgress({ loaded: 0, total: count ?? null })

      // Keyset pagination by (order_finalized_at, id), not plain id — a
      // cursor ordered by id while filtering on order_finalized_at can't
      // use an index to seek to the matching date range (see
      // 20260907_droptop_orders_date_index.sql), which is what made a
      // narrow custom range time out even though a wide one loaded fine.
      //
      // PAGE was briefly raised to 3000 to cut round trips, but this
      // Supabase project's API "Max Rows" setting silently caps EVERY
      // response at 1000 regardless of what .limit() requests. That alone
      // was harmless — the real bug was the loop's exit condition
      // (`batch.length < PAGE`) reading "server gave me fewer than I
      // asked for" as "that's the last page": with every response capped
      // at 1000 and PAGE=3000, every page looked short, so the loop
      // stopped after page one and silently dropped everything past the
      // first 1000 orders. Fixed the exit condition to only stop on a
      // genuinely EMPTY page, which is correct regardless of whatever the
      // real cap is now or later, and reverted PAGE to 1000 to match the
      // actual ceiling instead of requesting more than will ever be
      // honored.
      const PAGE = 1000
      const allOrders: OrderRow[] = []
      let cursor: { date: string; id: string } | null = null
      // A full company-wide range is 100+ sequential page requests — one
      // page hitting "canceling statement due to statement timeout" (a
      // real report — transient contention, not a structural problem,
      // since this exact query pattern runs in ~280ms per page normally)
      // used to throw immediately and discard everything fetched so far,
      // even 100+ pages in. One page is now retried up to twice (with a
      // short backoff) before actually giving up — same fix already
      // applied to the Heatmap's identical fetch loop.
      const MAX_PAGE_RETRIES = 2
      for (;;) {
        let data: OrderRow[] | null = null
        let lastErr: string | null = null
        for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
          if (cancelled) return
          let q = applyFilters(sb.schema('inventory').from('droptop_orders')
            .select('id, location_id, order_id, first_name, last_name, city, region, status, subtotal, final_price, order_finalized_at'))
            .order('order_finalized_at', { ascending: true })
            .order('id', { ascending: true }).limit(PAGE)
          if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
          const { data: pageData, error: err } = await q
          if (!err) { data = (pageData ?? []) as OrderRow[]; break }
          lastErr = err.message
          if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
        if (data === null) {
          throw new Error(`${lastErr ?? 'Failed to load orders'} — loaded ${allOrders.length.toLocaleString()} order(s) before this happened`)
        }
        allOrders.push(...data)
        if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: allOrders.length }))
        if (data.length === 0) break
        const last = data[data.length - 1]
        cursor = { date: last.order_finalized_at ?? startIso, id: last.id }
      }
      if (cancelled) return

      const orderIds = allOrders.map((o) => o.id)
      const [pkgRows, prodRows, svcRows] = orderIds.length
        ? await Promise.all([
          fetchByOrderIds<PackageRow>('droptop_order_packages', orderIds, 'order_id, package_id, name, price_total, price_total_after_discount'),
          fetchByOrderIds<ProductRow>('droptop_order_products', orderIds, 'order_id, product_id, product_type, uom, quantity_total'),
          fetchByOrderIds<ServiceRow>('droptop_order_services', orderIds, 'order_id, package_id, products'),
        ])
        : [[], [], []]
      if (cancelled) return

      setOrders(allOrders)
      setPackages(pkgRows)
      setProducts(prodRows)
      setServices(svcRows)
      setLoading(false)
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, range.start, range.end, shopIds.join(','), loadAllShops]) // eslint-disable-line react-hooks/exhaustive-deps

  const packagesByOrder = useMemo(() => {
    const m = new Map<string, PackageRow[]>()
    for (const p of packages) { const a = m.get(p.order_id) ?? []; a.push(p); m.set(p.order_id, a) }
    return m
  }, [packages])
  const productsByOrder = useMemo(() => {
    const m = new Map<string, ProductRow[]>()
    for (const p of products) { const a = m.get(p.order_id) ?? []; a.push(p); m.set(p.order_id, a) }
    return m
  }, [products])
  const servicesByOrder = useMemo(() => {
    const m = new Map<string, ServiceRow[]>()
    for (const s of services) { const a = m.get(s.order_id) ?? []; a.push(s); m.set(s.order_id, a) }
    return m
  }, [services])

  const allPackageNames = useMemo(
    () => [...new Set(packages.map((p) => p.name).filter((n): n is string => !!n))].sort(),
    [packages],
  )
  // How many package rows (in the current date/shop scope, before the
  // package/product/search filters below) carry each name — shown in the
  // multi-select so picking a package is informed by real volume.
  const packageOptionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of packages) if (p.name) m.set(p.name, (m.get(p.name) ?? 0) + 1)
    return m
  }, [packages])
  const packageOptions = useMemo(
    () => allPackageNames.map((n) => ({ value: n, count: packageOptionCounts.get(n) ?? 0 })),
    [allPackageNames, packageOptionCounts],
  )

  // Every product id that actually shows up on an order in scope, from
  // both sources — see the file header comment for why both are needed.
  const allProductIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of products) if (p.product_id) s.add(p.product_id)
    for (const svc of services) for (const pr of (svc.products ?? [])) if (pr.product_id) s.add(pr.product_id)
    return [...s].sort()
  }, [products, services])

  // Client-side filtering — package/product filters need the joined child
  // rows, and order volumes for a date-scoped, one-company query are light
  // enough that filtering after load (this app's usual convention for
  // config-tab-style pages) is simpler than a server-side join here.
  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (allowedLocationIds !== null && (!o.location_id || !allowedLocationIds.has(o.location_id))) return false
      if (packageFilters.length && !(packagesByOrder.get(o.id) ?? []).some((p) => p.name && packageFilters.includes(p.name))) return false
      if (productIdFilter) {
        const inTopLevel = (productsByOrder.get(o.id) ?? []).some((p) => p.product_id === productIdFilter)
        const inServices = (servicesByOrder.get(o.id) ?? []).some((s) => (s.products ?? []).some((p) => p.product_id === productIdFilter))
        if (!inTopLevel && !inServices) return false
      }
      if (q) {
        const hay = `${o.order_id} ${o.first_name ?? ''} ${o.last_name ?? ''} ${o.city ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [orders, packagesByOrder, productsByOrder, servicesByOrder, search, packageFilters, productIdFilter, allowedLocationIds])

  const filteredOrderIds = useMemo(() => new Set(filteredOrders.map((o) => o.id)), [filteredOrders])

  // Paginated for render — the underlying filtered set can be tens of
  // thousands of rows (a busy shop over a wide range), and rendering all of
  // them into the DOM at once is what was making the page laggy after load,
  // separately from how long the initial query itself took.
  const ORDERS_PAGE_SIZE = 100
  const [ordersPage, setOrdersPage] = useState(0)
  useEffect(() => { setOrdersPage(0) }, [filteredOrders])
  const totalOrderPages = Math.max(1, Math.ceil(filteredOrders.length / ORDERS_PAGE_SIZE))
  const pagedOrders = useMemo(
    () => filteredOrders.slice(ordersPage * ORDERS_PAGE_SIZE, (ordersPage + 1) * ORDERS_PAGE_SIZE),
    [filteredOrders, ordersPage],
  )

  // package_id -> display name, built globally (Droptop's package_id is a
  // stable identifier across every order it appears on, so one lookup
  // covers the whole loaded set rather than needing to search per-order).
  const packageNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of packages) if (p.name && p.package_id && !m.has(p.package_id)) m.set(p.package_id, p.name)
    return m
  }, [packages])

  // Package-level stats: count + average oil quarts (services-linked
  // products with uom = QT), scoped to the currently-filtered order set.
  const packageStats = useMemo(() => {
    const stats = new Map<string, { count: number; oilQuartsTotal: number }>()
    for (const p of packages) {
      if (!filteredOrderIds.has(p.order_id) || !p.name) continue
      const s = stats.get(p.name) ?? { count: 0, oilQuartsTotal: 0 }
      s.count++
      stats.set(p.name, s)
    }
    for (const s of services) {
      if (!filteredOrderIds.has(s.order_id) || !s.package_id) continue
      const pkgName = packageNameById.get(s.package_id)
      if (!pkgName) continue
      const oilQty = (s.products ?? []).filter((pr) => isQuart(pr.uom)).reduce((sum, pr) => sum + (Number(pr.quantity_total) || 0), 0)
      const entry = stats.get(pkgName)
      if (entry) entry.oilQuartsTotal += oilQty
    }
    return [...stats.entries()]
      .map(([name, s]) => ({ name, count: s.count, avgOilQuarts: s.count > 0 ? s.oilQuartsTotal / s.count : 0 }))
      .sort((a, b) => b.count - a.count)
  }, [packages, services, packageNameById, filteredOrderIds])

  const totals = useMemo(() => {
    const revenue = filteredOrders.reduce((sum, o) => sum + (o.final_price ?? 0), 0)
    return {
      count: filteredOrders.length,
      revenue,
      avgOrderValue: filteredOrders.length ? revenue / filteredOrders.length : 0,
    }
  }, [filteredOrders])

  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)

  // Exports the full filtered set (every order matching the current
  // filters), not just the current page of pagedOrders — pagination is a
  // rendering concern only, the export should match what "Orders (N)"
  // above it says, not what's currently scrolled into view.
  function exportOrders(format: 'csv' | 'xlsx') {
    if (!filteredOrders.length) { toast.error('Nothing to export for these filters'); return }
    setExporting(format)
    try {
      const headers = ['Order #', 'Shop', 'Customer', 'City', 'Status', 'Packages', 'Total', 'Finalized']
      const dataRows = filteredOrders.map((o) => [
        o.order_id,
        o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—',
        [o.first_name, o.last_name].filter(Boolean).join(' ') || '—',
        o.city || '—',
        o.status || '—',
        (packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—',
        o.final_price ?? 0,
        o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—',
      ])
      const fileBase = `droptop-orders-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...dataRows].map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
        XLSX.utils.book_append_sheet(wb, ws, 'Droptop Orders')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`)
      }
      toast.success('Export downloaded')
    } finally {
      setExporting(null)
    }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Droptop Orders</h1>
        <p className="text-xs text-inky mt-0.5">
          Search, filter, and summarize synced orders. Populated by Config → Data Connections' Droptop — Orders sync.
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-end gap-2 flex-wrap">
        <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} customEnd={customEnd}
          onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} earliestDate={earliestDate} />
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
          <MultiSelectDropdown options={shopOptions} selected={shopLabels}
            onChange={(labels) => { setShopLabels(labels); if (labels.length) setLoadAllShops(false) }}
            placeholder="All Shops" countNoun="shops" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Region</span>
          <MultiSelectDropdown options={regionOptions} selected={filterRegions} onChange={setFilterRegions} placeholder="All Regions" countNoun="regions" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Market</span>
          <MultiSelectDropdown options={marketOptions} selected={filterMarkets} onChange={setFilterMarkets} placeholder="All Markets" countNoun="markets" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Area Manager</span>
          <MultiSelectDropdown options={amOptions} selected={filterAMs} onChange={setFilterAMs} placeholder="All AMs" countNoun="AMs" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Package(s)</span>
          <MultiSelectDropdown options={packageOptions} selected={packageFilters} onChange={setPackageFilters} placeholder="All Packages" countNoun="packages" searchable />
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Product ID</span>
          <select value={productIdFilter} onChange={(e) => setProductIdFilter(e.target.value)} className={`${fieldCls} min-w-[160px]`}>
            <option value="">All Products</option>
            {allProductIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        {loadAllShops && (
          <button onClick={() => setLoadAllShops(false)}
            className="px-2 py-1.5 rounded border border-[#E67E22]/40 bg-[#E67E22]/10 text-[10px] font-mono uppercase tracking-wide text-[#E67E22] hover:bg-[#E67E22]/20 transition-colors"
            title="Click to stop loading every shop and go back to requiring a shop selection">
            Showing All Shops ✕
          </button>
        )}
        <label className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Search</span>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order #, customer name, city…" />
        </label>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {!shopIds.length && !loadAllShops ? (
        <Card><CardBody className="flex flex-col gap-2">
          <p className="text-xs font-mono text-inky/60">
            Select at least one shop above to load orders — an unscoped pull across every shop for a date range is
            slow and disabled by default.
          </p>
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setLoadAllShops(true)}>
            Load All Shops for This Period
          </Button>
        </CardBody></Card>
      ) : loading ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <div className="w-full max-w-md h-2 bg-navy/10 rounded-full overflow-hidden">
            {loadProgress.total ? (
              <div
                className="h-full bg-sky transition-[width] duration-300 ease-out"
                style={{ width: `${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%` }}
              />
            ) : (
              <div className="h-full w-full bg-sky/40 animate-pulse" />
            )}
          </div>
          <p className="text-[11px] font-mono text-inky/70">
            {loadProgress.total
              ? `Loading orders — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
              : loadProgress.loaded > 0
                ? `Loading orders — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                : 'Loading orders…'}
          </p>
        </div>
      ) : (
        <>
          {/* High-level stats */}
          <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Orders</p>
              <p className="text-lg font-heading font-bold text-navy">{totals.count.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Revenue</p>
              <p className="text-lg font-heading font-bold text-navy">{money(totals.revenue)}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Avg Order Value</p>
              <p className="text-lg font-heading font-bold text-navy">{money(totals.avgOrderValue)}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Distinct Packages</p>
              <p className="text-lg font-heading font-bold text-navy">{packageStats.length}</p>
            </CardBody></Card>
          </div>

          {/* Package summary: count + avg oil quarts */}
          <Card>
            <CardBody className="flex flex-col gap-2">
              <span className="text-xs font-mono text-navy uppercase tracking-wide">By Package</span>
              {packageStats.length === 0 ? (
                <p className="text-xs font-mono text-inky/60">No packages in this filtered set.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-navy/30 max-h-72 overflow-y-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-cream">
                      <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                        <th className="px-3 py-2 text-left">Package</th>
                        <th className="px-3 py-2 text-right">Count</th>
                        <th className="px-3 py-2 text-right">Avg Oil (Qts)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {packageStats.map((s) => (
                        <tr key={s.name} className="border-b border-navy/10">
                          <td className="px-3 py-1.5 text-navy">{s.name}</td>
                          <td className="px-3 py-1.5 text-navy text-right">{s.count}</td>
                          <td className="px-3 py-1.5 text-navy text-right">{s.avgOilQuarts > 0 ? s.avgOilQuarts.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Orders table — paginated client-side; rendering the full
              filtered set (can be tens of thousands of rows) at once was
              what made the page laggy after loading, separately from load
              time itself. */}
          <Card>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">Orders ({filteredOrders.length.toLocaleString()})</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" variant="secondary" loading={exporting === 'csv'} onClick={() => exportOrders('csv')}>Export CSV</Button>
                  <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} onClick={() => exportOrders('xlsx')}>Export Excel</Button>
                  {filteredOrders.length > ORDERS_PAGE_SIZE && (
                    <div className="flex items-center gap-2 text-[10px] font-mono text-inky/70">
                      <Button size="sm" variant="secondary" disabled={ordersPage === 0} onClick={() => setOrdersPage((p) => Math.max(0, p - 1))}>Prev</Button>
                      <span>Page {ordersPage + 1} of {totalOrderPages}</span>
                      <Button size="sm" variant="secondary" disabled={ordersPage >= totalOrderPages - 1} onClick={() => setOrdersPage((p) => Math.min(totalOrderPages - 1, p + 1))}>Next</Button>
                    </div>
                  )}
                </div>
              </div>
              {filteredOrders.length === 0 ? (
                <p className="text-xs font-mono text-inky/60">No orders match these filters.</p>
              ) : (
                <div className="overflow-x-auto rounded border border-navy/30 max-h-[32rem] overflow-y-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-cream">
                      <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                        <th className="px-3 py-2 text-left">Order #</th>
                        <th className="px-3 py-2 text-left">Shop</th>
                        <th className="px-3 py-2 text-left">Customer</th>
                        <th className="px-3 py-2 text-left">City</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-left">Packages</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2 text-left">Finalized</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedOrders.map((o) => (
                        <tr key={o.id} className="border-b border-navy/10">
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_id}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{[o.first_name, o.last_name].filter(Boolean).join(' ') || '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.city || '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.status || '—'}</td>
                          <td className="px-3 py-1.5 text-navy">{(packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—'}</td>
                          <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(o.final_price)}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
