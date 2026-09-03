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
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { Button, Card, CardBody, Input, Modal, MultiSelectDropdown } from '@/components/ui'
import { fetchDateRangeConcurrent } from '@/lib/concurrentDateRangeFetch'

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
  // From the Droptop expanded-fields work — set when the order is a
  // fleet/B2B account, null for an ordinary retail order.
  fleet_company_name: string | null
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
interface VehicleRow {
  order_id: string
  vin: string | null
  license_plate: string | null
  vehicle_name: string | null
  vin_vehicle_make: string | null
  vin_vehicle_model: string | null
  vin_vehicle_year: number | null
}

// One column of the Build Your Own Report's order-level detail mode.
interface TableCol2 { key: string; label: string; get: (o: OrderRow) => string; align?: 'right' }

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const isQuart = (uom: string | null | undefined) => (uom ?? '').trim().toUpperCase() === 'QT'
const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

// Order-id chunk size for fetchByOrderIds below — module-level so the
// caller's own progress tracking (how many chunks are left across the 3
// parallel calls) can compute the same total without the two ever drifting
// apart.
const ORDER_ID_CHUNK = 200

// How many order-id chunks to fetch at once, per table. Chunks are
// independent of each other (each is its own `order_id IN (...)` scope,
// unlike the pages WITHIN a chunk which depend on each other's cursor), so
// running several concurrently is free correctness-wise — this stacks with
// the 4 tables already running concurrently with each other via Promise.all
// in the caller, so a big pull now has up to CHUNK_CONCURRENCY × 4 requests
// in flight at once instead of 4.
const CHUNK_CONCURRENCY = 4

// Fetch rows for a batch of order ids, chunking the input AND paginating
// each chunk's output. CHUNK alone isn't enough — this project's Supabase
// "Max Rows" API setting silently caps every response at 1000 regardless
// of .limit(), and a chunk of order ids can produce more result rows than
// input ids (an order can have multiple packages/products/services), so
// an unpaginated .in() could silently drop rows past 1000 with no error.
// Same fix as the main orders loop: keep fetching by (id) cursor per
// chunk until a genuinely empty page. `onChunk` fires once per outer
// chunk (not per inner page) — enough resolution for a progress bar
// without the caller needing to know about the inner pagination at all.
async function fetchByOrderIds<T>(table: string, orderIds: string[], select: string, onChunk?: () => void): Promise<T[]> {
  const sb = supabase as any
  const CHUNK = ORDER_ID_CHUNK
  const PAGE = 1000
  const MAX_PAGE_RETRIES = 2

  async function fetchChunk(slice: string[]): Promise<T[]> {
    const out: T[] = []
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
    onChunk?.()
    return out
  }

  const chunks: string[][] = []
  for (let i = 0; i < orderIds.length; i += CHUNK) chunks.push(orderIds.slice(i, i + CHUNK))

  // Bounded worker pool — CHUNK_CONCURRENCY chunks in flight at once,
  // pulling the next one off the queue as each finishes, rather than firing
  // every chunk at once (which would just recreate the original "n
  // sequential" problem's opposite failure mode: hundreds of requests
  // competing for the same connection pool at once on a very large pull).
  const results: T[][] = new Array(chunks.length)
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const i = nextIndex++
      if (i >= chunks.length) return
      results[i] = await fetchChunk(chunks[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
  return results.flat()
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
  const [productIdFilters, setProductIdFilters] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [packages, setPackages] = useState<PackageRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [services, setServices] = useState<ServiceRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Real progress instead of a bare spinner — same pattern as Customer
  // Heatmap's full-detail load: a cheap COUNT-only request up front gives
  // a denominator, `loaded` ticks up per page.
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })
  // Second phase — package/product/service child rows for every order
  // header just loaded. loadProgress alone used to sit frozen at 100% while
  // this ran (visible on a big pull — 47k+ orders' worth of child fetching
  // is not instant), with nothing telling the user anything was still
  // happening. total is chunks-to-fetch across all 3 tables combined
  // (see ORDER_ID_CHUNK), not row counts — coarser than the header phase's
  // per-order count, but real movement instead of a stall.
  const [detailProgress, setDetailProgress] = useState<{ loaded: number; total: number } | null>(null)

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
    setDetailProgress(null)
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
      // A full company-wide range used to be 100+ SEQUENTIAL page requests
      // — correct, but every page waited on the previous one's round trip
      // even though the table can serve several requests at once.
      // fetchDateRangeConcurrent (src/lib) keeps this exact keyset-
      // pagination shape (still index-friendly on the date range, still
      // safe to retry a single page) but runs it across several non-
      // overlapping day-range slices in parallel instead of one loop
      // covering the whole range — see that file's own comment for why
      // slicing by date rather than plain OFFSET paging.
      const MAX_PAGE_RETRIES = 2
      let loadedSoFarLocal = 0
      const allOrders = await fetchDateRangeConcurrent<OrderRow>({
        rangeStart: range.start,
        rangeEnd: range.end,
        totalCount: count ?? null,
        cursorOf: (row) => ({ date: row.order_finalized_at ?? startIso, id: row.id }),
        isCancelled: () => cancelled,
        onProgress: (loadedSoFar) => { loadedSoFarLocal = loadedSoFar; if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: loadedSoFar })) },
        fetchPage: async (subStart, subEnd, cursor) => {
          const subStartIso = `${subStart}T00:00:00.000Z`
          const subEndIso = `${subEnd}T23:59:59.999Z`
          let lastErr: string | null = null
          for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
            if (cancelled) return []
            let q = applyFilters(sb.schema('inventory').from('droptop_orders')
              .select('id, location_id, order_id, first_name, last_name, city, region, status, subtotal, final_price, order_finalized_at, fleet_company_name'))
              .gte('order_finalized_at', subStartIso).lte('order_finalized_at', subEndIso)
              .order('order_finalized_at', { ascending: true })
              .order('id', { ascending: true }).limit(PAGE)
            if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
            const { data: pageData, error: err } = await q
            if (!err) return (pageData ?? []) as OrderRow[]
            lastErr = err.message
            if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          }
          throw new Error(`${lastErr ?? 'Failed to load orders'} — loaded ${loadedSoFarLocal.toLocaleString()} order(s) before this happened`)
        },
      })
      if (cancelled) return

      const orderIds = allOrders.map((o) => o.id)
      let pkgRows: PackageRow[] = [], prodRows: ProductRow[] = [], svcRows: ServiceRow[] = [], vehRows: VehicleRow[] = []
      if (orderIds.length) {
        const chunksPerTable = Math.ceil(orderIds.length / ORDER_ID_CHUNK)
        if (!cancelled) setDetailProgress({ loaded: 0, total: chunksPerTable * 4 })
        const onChunk = () => { if (!cancelled) setDetailProgress((p) => (p ? { ...p, loaded: p.loaded + 1 } : p)) }
        ;[pkgRows, prodRows, svcRows, vehRows] = await Promise.all([
          fetchByOrderIds<PackageRow>('droptop_order_packages', orderIds, 'order_id, package_id, name, price_total, price_total_after_discount', onChunk),
          fetchByOrderIds<ProductRow>('droptop_order_products', orderIds, 'order_id, product_id, product_type, uom, quantity_total', onChunk),
          fetchByOrderIds<ServiceRow>('droptop_order_services', orderIds, 'order_id, package_id, products', onChunk),
          fetchByOrderIds<VehicleRow>('droptop_order_vehicles', orderIds, 'order_id, vin, license_plate, vehicle_name, vin_vehicle_make, vin_vehicle_model, vin_vehicle_year', onChunk),
        ])
      }
      if (cancelled) return

      setOrders(allOrders)
      setPackages(pkgRows)
      setProducts(prodRows)
      setServices(svcRows)
      setVehicles(vehRows)
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
  const vehiclesByOrder = useMemo(() => {
    const m = new Map<string, VehicleRow[]>()
    for (const v of vehicles) { const a = m.get(v.order_id) ?? []; a.push(v); m.set(v.order_id, a) }
    return m
  }, [vehicles])

  // Distinct product ids on an order, from both sources (top-level products
  // array + services' nested products — see the file header comment).
  function productIdsFor(orderId: string): string[] {
    const s = new Set<string>()
    for (const p of productsByOrder.get(orderId) ?? []) if (p.product_id) s.add(p.product_id)
    for (const svc of servicesByOrder.get(orderId) ?? []) for (const pr of (svc.products ?? [])) if (pr.product_id) s.add(pr.product_id)
    return [...s]
  }
  // Total oil quarts on an order — same QT-uom convention as
  // packageStats' own oil-quarts calc, just summed across the whole order
  // instead of grouped by package.
  function quartsFor(orderId: string): number {
    let total = 0
    for (const p of productsByOrder.get(orderId) ?? []) if (isQuart(p.uom)) total += Number(p.quantity_total) || 0
    for (const svc of servicesByOrder.get(orderId) ?? []) for (const pr of (svc.products ?? [])) if (isQuart(pr.uom)) total += Number(pr.quantity_total) || 0
    return total
  }
  // One line per vehicle, joined — an order occasionally carries more than
  // one (a multi-vehicle fleet drop-off).
  function vehicleLabelFor(orderId: string): string {
    const vs = vehiclesByOrder.get(orderId) ?? []
    if (!vs.length) return '—'
    return vs.map((v) => {
      const yearMakeModel = [v.vin_vehicle_year, v.vin_vehicle_make, v.vin_vehicle_model].filter(Boolean).join(' ')
      return yearMakeModel || v.vehicle_name || v.license_plate || v.vin || '—'
    }).join('; ')
  }

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
  // Occurrence counts across both sources, same convention as
  // packageOptionCounts — shown in the multi-select so picking a product is
  // informed by real volume.
  const productIdOptionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of products) if (p.product_id) m.set(p.product_id, (m.get(p.product_id) ?? 0) + 1)
    for (const svc of services) for (const pr of (svc.products ?? [])) if (pr.product_id) m.set(pr.product_id, (m.get(pr.product_id) ?? 0) + 1)
    return m
  }, [products, services])
  const productIdOptions = useMemo(
    () => allProductIds.map((id) => ({ value: id, count: productIdOptionCounts.get(id) ?? 0 })),
    [allProductIds, productIdOptionCounts],
  )

  // Client-side filtering — package/product filters need the joined child
  // rows, and order volumes for a date-scoped, one-company query are light
  // enough that filtering after load (this app's usual convention for
  // config-tab-style pages) is simpler than a server-side join here.
  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (allowedLocationIds !== null && (!o.location_id || !allowedLocationIds.has(o.location_id))) return false
      if (packageFilters.length && !(packagesByOrder.get(o.id) ?? []).some((p) => p.name && packageFilters.includes(p.name))) return false
      if (productIdFilters.length) {
        const inTopLevel = (productsByOrder.get(o.id) ?? []).some((p) => p.product_id && productIdFilters.includes(p.product_id))
        const inServices = (servicesByOrder.get(o.id) ?? []).some((s) => (s.products ?? []).some((p) => p.product_id && productIdFilters.includes(p.product_id)))
        if (!inTopLevel && !inServices) return false
      }
      if (q) {
        const hay = `${o.order_id} ${o.first_name ?? ''} ${o.last_name ?? ''} ${o.city ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [orders, packagesByOrder, productsByOrder, servicesByOrder, search, packageFilters, productIdFilters, allowedLocationIds])

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
    // Average quarts per order, counting only orders that actually had a
    // quart-uom (oil-change) product on them — an order with no oil at all
    // (a tire rotation, a filter-only visit) would just drag this toward
    // zero rather than answer "for the oil changes we did, how much oil".
    let oilOrderCount = 0, oilQuartsTotal = 0
    for (const o of filteredOrders) {
      const q = quartsFor(o.id)
      if (q > 0) { oilOrderCount++; oilQuartsTotal += q }
    }
    return {
      count: filteredOrders.length,
      revenue,
      avgOrderValue: filteredOrders.length ? revenue / filteredOrders.length : 0,
      avgQuartsPerOilOrder: oilOrderCount ? oilQuartsTotal / oilOrderCount : 0,
      oilOrderCount,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, productsByOrder, servicesByOrder])

  // Shop-level rollup: how many orders per shop, and (of the ones that
  // included an oil-change product) the average quarts per order — same
  // "only count orders that actually had oil" reasoning as totals above,
  // just broken out by shop instead of company-wide.
  const shopStats = useMemo(() => {
    const stats = new Map<string, { count: number; oilOrderCount: number; oilQuartsTotal: number }>()
    for (const o of filteredOrders) {
      const key = o.location_id ?? '—'
      const s = stats.get(key) ?? { count: 0, oilOrderCount: 0, oilQuartsTotal: 0 }
      s.count++
      const q = quartsFor(o.id)
      if (q > 0) { s.oilOrderCount++; s.oilQuartsTotal += q }
      stats.set(key, s)
    }
    return [...stats.entries()]
      .map(([locationId, s]) => ({
        locationId,
        shopLabel: locationId === '—' ? '—' : (idToLabel.get(locationId) ?? locationId),
        count: s.count,
        avgQuarts: s.oilOrderCount ? s.oilQuartsTotal / s.oilOrderCount : 0,
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, productsByOrder, servicesByOrder, idToLabel])

  // ---- Build Your Own Report ------------------------------------------
  // Operates on whatever's already loaded (filteredOrders — respects the
  // page's own date range, Shop(s), and search/package/product filters
  // above) rather than firing an independent fetch: a genuinely separate
  // report date range/shop scope would mean duplicating this page's whole
  // load pipeline (header fetch + 4 child-table fetches, both now
  // concurrent — see concurrentDateRangeFetch.ts) a second time. The
  // report's own Region/Market/AM/Shop pickers below narrow further,
  // client-side, within that already-loaded set — widen the Shop(s)/date
  // range above first if a shop/date isn't showing up as an option here.
  const [reportOpen, setReportOpen] = useState(false)
  const [reportMode, setReportMode] = useState<'detail' | 'totals'>('detail')
  const DETAIL_COLUMNS: TableCol2[] = [
    { key: 'order_id', label: 'Order #', get: (o) => o.order_id },
    { key: 'shop', label: 'Shop', get: (o) => (o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—') },
    { key: 'region', label: 'Region', get: (o) => o.region || '—' },
    { key: 'customer', label: 'Customer', get: (o) => [o.first_name, o.last_name].filter(Boolean).join(' ') || '—' },
    { key: 'city', label: 'City', get: (o) => o.city || '—' },
    { key: 'status', label: 'Status', get: (o) => o.status || '—' },
    { key: 'packages', label: 'Packages', get: (o) => (packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—' },
    { key: 'products', label: 'Products', get: (o) => productIdsFor(o.id).join(', ') || '—' },
    { key: 'quarts', label: 'Quarts', get: (o) => { const q = quartsFor(o.id); return q > 0 ? q.toFixed(2) : '—' }, align: 'right' },
    { key: 'vehicle', label: 'Vehicle', get: (o) => vehicleLabelFor(o.id) },
    { key: 'fleet', label: 'Fleet', get: (o) => o.fleet_company_name || '—' },
    { key: 'subtotal', label: 'Subtotal', get: (o) => money(o.subtotal), align: 'right' },
    { key: 'total', label: 'Total', get: (o) => money(o.final_price), align: 'right' },
    { key: 'finalized', label: 'Finalized', get: (o) => (o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—') },
  ]
  const [reportColumnKeys, setReportColumnKeys] = useState<string[]>(['order_id', 'shop', 'customer', 'packages', 'quarts', 'total', 'finalized'])
  const [reportRegions, setReportRegions] = useState<string[]>([])
  const [reportMarkets, setReportMarkets] = useState<string[]>([])
  const [reportAMs, setReportAMs] = useState<string[]>([])
  const [reportShops, setReportShops] = useState<string[]>([])
  const [reportExporting, setReportExporting] = useState<'csv' | 'xlsx' | null>(null)

  const reportShopLabelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const reportOrders = useMemo(() => {
    const reportShopIds = new Set(reportShops.map((l) => reportShopLabelToId.get(l)).filter((v): v is string => !!v))
    return filteredOrders.filter((o) => {
      if (!o.location_id) return reportRegions.length === 0 && reportMarkets.length === 0 && reportAMs.length === 0 && reportShopIds.size === 0
      if (reportShopIds.size && !reportShopIds.has(o.location_id)) return false
      if (reportRegions.length && !reportRegions.includes(loc.byId(o.location_id)?.region ?? '')) return false
      if (reportMarkets.length && !reportMarkets.includes(loc.fieldValue(o.location_id, 'market'))) return false
      if (reportAMs.length && !reportAMs.includes(loc.fieldValue(o.location_id, 'area_manager'))) return false
      return true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, reportRegions, reportMarkets, reportAMs, reportShops, reportShopLabelToId, loc])

  interface ShopTotalsRow { shopLabel: string; orders: number; subtotal: number; total: number; quarts: number; packages: number }
  const TOTALS_COLUMNS: { key: string; label: string; get: (r: ShopTotalsRow) => string; align?: 'right' }[] = [
    { key: 'shop', label: 'Shop', get: (r) => r.shopLabel },
    { key: 'orders', label: 'Orders', get: (r) => String(r.orders), align: 'right' },
    { key: 'packages', label: 'Packages', get: (r) => String(r.packages), align: 'right' },
    { key: 'quarts', label: 'Quarts', get: (r) => (r.quarts > 0 ? r.quarts.toFixed(2) : '—'), align: 'right' },
    { key: 'subtotal', label: 'Subtotal', get: (r) => money(r.subtotal), align: 'right' },
    { key: 'total', label: 'Total', get: (r) => money(r.total), align: 'right' },
  ]
  const reportTotalsRows = useMemo((): ShopTotalsRow[] => {
    const stats = new Map<string, ShopTotalsRow>()
    for (const o of reportOrders) {
      const shopLabel = o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—'
      const r = stats.get(shopLabel) ?? { shopLabel, orders: 0, subtotal: 0, total: 0, quarts: 0, packages: 0 }
      r.orders++
      r.subtotal += o.subtotal ?? 0
      r.total += o.final_price ?? 0
      r.quarts += quartsFor(o.id)
      r.packages += (packagesByOrder.get(o.id) ?? []).length
      stats.set(shopLabel, r)
    }
    return [...stats.values()].sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportOrders, packagesByOrder, idToLabel])

  const activeDetailCols = DETAIL_COLUMNS.filter((c) => reportColumnKeys.includes(c.key))
  const activeTotalsCols = TOTALS_COLUMNS.filter((c) => reportColumnKeys.includes(c.key))

  function reportCsvRows(): { headers: string[]; rows: string[][] } {
    if (reportMode === 'detail') {
      return { headers: activeDetailCols.map((c) => c.label), rows: reportOrders.map((o) => activeDetailCols.map((c) => c.get(o))) }
    }
    return { headers: activeTotalsCols.map((c) => c.label), rows: reportTotalsRows.map((r) => activeTotalsCols.map((c) => c.get(r))) }
  }
  function exportReport(format: 'csv' | 'xlsx') {
    const { headers, rows } = reportCsvRows()
    if (!rows.length) { toast.error('Nothing to export for this report'); return }
    setReportExporting(format)
    try {
      const fileBase = `droptop-report-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
        XLSX.utils.book_append_sheet(wb, ws, 'Report')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`)
      }
      toast.success('Report downloaded')
    } finally {
      setReportExporting(null)
    }
  }
  async function copyReport() {
    const { headers, rows } = reportCsvRows()
    if (!rows.length) { toast.error('Nothing to copy for this report'); return }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const title = `Droptop Report — ${range.start} to ${range.end}`
    const head = `<tr>${headers.map((h) => `<td style="border:1px solid #002745;background:#B7E0DE;color:#002745;padding:4px 8px;font-weight:bold;">${esc(h)}</td>`).join('')}</tr>`
    const body = rows.map((r, i) => `<tr>${r.map((c) => `<td style="border:1px solid #4F7489;padding:3px 8px;background:${i % 2 ? '#F2F1E6' : '#FFFFFF'};">${esc(c)}</td>`).join('')}</tr>`).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#002745;"><div style="font-weight:bold;margin-bottom:4px;">${esc(title)}</div><table style="border-collapse:collapse;font-size:12px;"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    const plain = [title, headers.join('\t'), ...rows.map((r) => r.join('\t'))].join('\n')
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })])
      } else {
        await navigator.clipboard.writeText(plain)
      }
      toast.success('Report copied to clipboard')
    } catch { toast.error('Copy failed') }
  }
  // ---- end Build Your Own Report ---------------------------------------

  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)

  // Exports the full filtered set (every order matching the current
  // filters), not just the current page of pagedOrders — pagination is a
  // rendering concern only, the export should match what "Orders (N)"
  // above it says, not what's currently scrolled into view.
  function exportOrders(format: 'csv' | 'xlsx') {
    if (!filteredOrders.length) { toast.error('Nothing to export for these filters'); return }
    setExporting(format)
    try {
      const headers = ['Order #', 'Shop', 'Customer', 'City', 'Status', 'Packages', 'Products', 'Quarts', 'Vehicle', 'Fleet', 'Total', 'Finalized']
      const dataRows = filteredOrders.map((o) => [
        o.order_id,
        o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—',
        [o.first_name, o.last_name].filter(Boolean).join(' ') || '—',
        o.city || '—',
        o.status || '—',
        (packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—',
        productIdsFor(o.id).join(', ') || '—',
        quartsFor(o.id) || 0,
        vehicleLabelFor(o.id),
        o.fleet_company_name || '—',
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
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Product ID</span>
          <MultiSelectDropdown options={productIdOptions} selected={productIdFilters} onChange={setProductIdFilters} placeholder="All Products" countNoun="products" searchable />
        </div>
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
        <LoadingProgress
          fraction={
            detailProgress ? detailProgress.loaded / detailProgress.total
              : loadProgress.total ? loadProgress.loaded / loadProgress.total : null
          }
          countText={
            detailProgress
              ? `Loading package/product details — ${detailProgress.loaded.toLocaleString()} of ${detailProgress.total.toLocaleString()} batches (${Math.min(100, Math.round((detailProgress.loaded / detailProgress.total) * 100))}%)`
              : loadProgress.total
                ? `Loading orders — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
                : loadProgress.loaded > 0
                  ? `Loading orders — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                  : 'Loading orders…'
          }
          messages={[
            'Pulling order headers…',
            'Matching packages to services…',
            'Tallying up totals…',
            'Sorting by date…',
          ]}
        />
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
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Avg Quarts (Oil Change)</p>
              <p className="text-lg font-heading font-bold text-navy">{totals.avgQuartsPerOilOrder > 0 ? totals.avgQuartsPerOilOrder.toFixed(2) : '—'}</p>
            </CardBody></Card>
          </div>

          {/* Package + Shop summaries, side by side — each half the width
              this used to take full-width, freeing room for the shop
              breakdown next to it. */}
          <div className="flex gap-3 flex-wrap items-start">
            <Card className="flex-1 min-w-[280px]">
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

            <Card className="flex-1 min-w-[280px]">
              <CardBody className="flex flex-col gap-2">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">By Shop ({shopStats.length})</span>
                {shopStats.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">No shops in this filtered set.</p>
                ) : (
                  <div className="overflow-x-auto rounded border border-navy/30 max-h-72 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead className="sticky top-0 bg-cream">
                        <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                          <th className="px-3 py-2 text-left">Shop</th>
                          <th className="px-3 py-2 text-right">Orders</th>
                          <th className="px-3 py-2 text-right">Avg Quarts / Order</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shopStats.map((s) => (
                          <tr key={s.locationId} className="border-b border-navy/10">
                            <td className="px-3 py-1.5 text-navy whitespace-nowrap">{s.shopLabel}</td>
                            <td className="px-3 py-1.5 text-navy text-right">{s.count}</td>
                            <td className="px-3 py-1.5 text-navy text-right">{s.avgQuarts > 0 ? s.avgQuarts.toFixed(2) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          {/* Orders table — paginated client-side; rendering the full
              filtered set (can be tens of thousands of rows) at once was
              what made the page laggy after loading, separately from load
              time itself. */}
          <Card>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">Orders ({filteredOrders.length.toLocaleString()})</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" variant="secondary" onClick={() => setReportOpen(true)}>Build Report</Button>
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
                        <th className="px-3 py-2 text-left">Products</th>
                        <th className="px-3 py-2 text-right">Quarts</th>
                        <th className="px-3 py-2 text-left">Vehicle</th>
                        <th className="px-3 py-2 text-left">Fleet</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2 text-left">Finalized</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedOrders.map((o) => {
                        const quarts = quartsFor(o.id)
                        return (
                        <tr key={o.id} className="border-b border-navy/10">
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_id}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{[o.first_name, o.last_name].filter(Boolean).join(' ') || '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.city || '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.status || '—'}</td>
                          <td className="px-3 py-1.5 text-navy">{(packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—'}</td>
                          <td className="px-3 py-1.5 text-navy">{productIdsFor(o.id).join(', ') || '—'}</td>
                          <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{quarts > 0 ? quarts.toFixed(2) : '—'}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{vehicleLabelFor(o.id)}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.fleet_company_name || '—'}</td>
                          <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(o.final_price)}</td>
                          <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—'}</td>
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}

      <Modal open={reportOpen} onClose={() => setReportOpen(false)} title="Build Your Own Report" size="2xl">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            Built from what&apos;s already loaded above ({range.start} to {range.end}) — the pickers below narrow that
            further, they don&apos;t pull in shops or dates outside it. Widen the Shop(s)/date range above first if
            something you need isn&apos;t showing up as an option here.
          </p>

          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Mode</span>
            <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
              {(['detail', 'totals'] as const).map((m) => (
                <button key={m} onClick={() => setReportMode(m)}
                  className={['px-2 py-1.5 uppercase tracking-wide transition-colors', reportMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                  {m === 'detail' ? 'Order-Level Detail' : 'Totals by Shop'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 flex-wrap">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Region</span>
              <MultiSelectDropdown options={regionOptions} selected={reportRegions} onChange={setReportRegions} placeholder="All Regions" countNoun="regions" searchable />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Market</span>
              <MultiSelectDropdown options={marketOptions} selected={reportMarkets} onChange={setReportMarkets} placeholder="All Markets" countNoun="markets" searchable />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Area Manager</span>
              <MultiSelectDropdown options={amOptions} selected={reportAMs} onChange={setReportAMs} placeholder="All AMs" countNoun="AMs" searchable />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
              <MultiSelectDropdown options={shopOptions} selected={reportShops} onChange={setReportShops} placeholder="All Shops" countNoun="shops" searchable />
            </div>
          </div>

          <div>
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide block mb-1">Columns</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(reportMode === 'detail' ? DETAIL_COLUMNS : TOTALS_COLUMNS).map((c) => (
                <label key={c.key} className="flex items-center gap-1.5 text-xs font-mono text-navy">
                  <input type="checkbox" checked={reportColumnKeys.includes(c.key)}
                    onChange={(e) => setReportColumnKeys((keys) => e.target.checked ? [...keys, c.key] : keys.filter((k) => k !== c.key))} />
                  {c.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-xs font-mono text-navy">
              {reportMode === 'detail' ? `${reportOrders.length.toLocaleString()} orders` : `${reportTotalsRows.length.toLocaleString()} shops`}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copyReport()}>Copy</Button>
              <Button size="sm" variant="secondary" loading={reportExporting === 'csv'} onClick={() => exportReport('csv')}>Export CSV</Button>
              <Button size="sm" variant="secondary" loading={reportExporting === 'xlsx'} onClick={() => exportReport('xlsx')}>Export Excel</Button>
            </div>
          </div>

          <div className="overflow-auto rounded border border-navy/30 max-h-96">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-cream"><tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                {(reportMode === 'detail' ? activeDetailCols : activeTotalsCols).map((c) => (
                  <th key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>{c.label}</th>
                ))}
              </tr></thead>
              <tbody>
                {reportMode === 'detail'
                  ? reportOrders.map((o) => (
                    <tr key={o.id} className="border-b border-navy/10">
                      {activeDetailCols.map((c) => (
                        <td key={c.key} className={`px-3 py-1.5 text-navy whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>{c.get(o)}</td>
                      ))}
                    </tr>
                  ))
                  : reportTotalsRows.map((r) => (
                    <tr key={r.shopLabel} className="border-b border-navy/10">
                      {activeTotalsCols.map((c) => (
                        <td key={c.key} className={`px-3 py-1.5 text-navy whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>{c.get(r)}</td>
                      ))}
                    </tr>
                  ))}
                {(reportMode === 'detail' ? reportOrders.length : reportTotalsRows.length) === 0 && (
                  <tr><td className="px-3 py-4 text-inky/50" colSpan={(reportMode === 'detail' ? activeDetailCols : activeTotalsCols).length || 1}>
                    Nothing matches this report's filters within what's currently loaded.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </Modal>
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
