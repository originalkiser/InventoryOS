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
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useEarliestOrderDate } from '@/hooks/useEarliestOrderDate'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { DataCompletenessBadge } from '@/components/shared/DataCompletenessBadge'
import { DataTable } from '@/components/shared/DataTable'
import { Button, Card, CardBody, Input, Modal, MultiSelectDropdown, SbLoader, Toggle } from '@/components/ui'
import { formatDistanceToNowStrict } from 'date-fns'
import { fetchDateRangeConcurrent } from '@/lib/concurrentDateRangeFetch'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { isM5, type Classification } from './PackageMappingPage'
import { deriveSummary, useOrderRollups } from './droptopRollups'

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
  // The package's own list price before any discount/coupon is applied —
  // what to compare against core.locations' configured price columns
  // (economy, premium_hm, etc.) to audit that Droptop is actually selling
  // at the price the location list says it should be.
  base_service_price: number | null
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
  mileage: number | null
}
// One page's worth of orders WITH their package/product/service/vehicle
// child rows attached — one call per page instead of a header pull
// followed by a separate per-order-id child-table pull. Was a plain
// PostgREST foreign-table select (each child embeds as an array nested on
// its parent row) until 2026-09-24, when that turned out to resolve as a
// correlated per-row subquery — see get_droptop_orders_embedded's own
// migration comment (20260930bh) for why it's now an RPC call instead.
// Shape is identical either way, so this does NOT change the pagination
// math — a page of 2,000 orders is still exactly 2,000 top-level rows
// regardless of how many packages/products/vehicles they carry between
// them, unlike a flat `.in('order_id', ids)` child-table query (see
// droptopChildFetch.ts for why THAT needed its own separate pagination).
interface OrderRowEmbedded extends OrderRow {
  droptop_order_packages: Omit<PackageRow, 'order_id'>[]
  droptop_order_products: Omit<ProductRow, 'order_id'>[]
  droptop_order_services: Omit<ServiceRow, 'order_id'>[]
  droptop_order_vehicles: Omit<VehicleRow, 'order_id'>[]
}

// One column of the Build Your Own Report's order-level detail mode.
interface TableCol2 { key: string; label: string; get: (o: OrderRow) => string; align?: 'right' }

interface ShopRow { id: string; locationId: string; shopLabel: string; orders: number; revenue: number | null; avgTicket: number | null; revShare: number | null; oilChanges: number | null; m5Pct: number | null; avgQuarts: number | null }
interface PackageRow2 { id: string; name: string; kind: string; orders: number; sold: number; revenue: number | null; avgPrice: number | null; soldShare: number | null; revShare: number | null; avgOilQuarts: number | null }

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const isQuart = (uom: string | null | undefined) => (uom ?? '').trim().toUpperCase() === 'QT'
const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

export function DroptopOrdersPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — franchise shops included by default here (unlike
  // Inventory-side pages), per explicit product decision 2026-09-01.
  const loc = useLocations('other')
  const earliestDate = useEarliestOrderDate(companyId)
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod('droptop-orders:period', 'last_30_days')

  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [packageFilters, setPackageFilters] = useState<string[]>([])
  const [productIdFilters, setProductIdFilters] = useState<string[]>([])
  const [vehicleModels, setVehicleModels] = useState<string[]>([])
  const [vehicleYears, setVehicleYears] = useState<string[]>([])
  const [fleetFilters, setFleetFilters] = useState<string[]>([])
  const [oilOnly, setOilOnly] = useState(false)
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


  // Whether the user has explicitly asked to load full order-level detail
  // for the current scope — the slow raw fetch below only runs once this
  // is true, rather than automatically whenever a shop/date range is
  // picked. Resets on any scope change (see the effect below, placed after
  // shopIds is declared), so switching periods/shops always requires a
  // fresh explicit request rather than silently reusing a detail load that
  // belongs to a different scope.
  const [detailRequested, setDetailRequested] = useState(false)

  // Package name -> Oil Change / one of 5 M5 sub-categories / None, from the
  // Package Mapping page (inventory.droptop_package_classification) — small
  // (~80-150 rows), loaded once per company rather than per filter/date-
  // range change.
  const [packageClassification, setPackageClassification] = useState<Map<string, Classification>>(new Map())
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.schema('inventory').from('droptop_package_classification')
      .select('package_name, classification').eq('company_id', companyId)
      .then(({ data }: any) => {
        if (cancelled) return
        setPackageClassification(new Map((data ?? []).map((r: { package_name: string; classification: Classification }) => [r.package_name, r.classification])))
      })
    return () => { cancelled = true }
  }, [companyId])

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const idToLabel = useMemo(() => new Map(loc.includedOptions.map((o) => [o.value, o.label])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])
  // Summary covers every shop unless some are picked; order detail loads on request, for the same scope.
  const loadAllShops = shopIds.length === 0
  useEffect(() => { setDetailRequested(false) }, [range.start, range.end, shopIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // The Region/Market/AM filters (allowedLocationIds) AND with whichever
  // shops are explicitly picked, exactly like filteredOrders below does
  // for the client-computed stats — the summary RPC needs the same
  // effective location set so its numbers agree with what the page shows
  // once order-level detail is loaded, not just whatever shopIds alone
  // resolves to.
  const summaryLocationIds = useMemo(() => {
    if (shopIds.length) return allowedLocationIds ? shopIds.filter((id) => allowedLocationIds.has(id)) : shopIds
    return allowedLocationIds ? [...allowedLocationIds] : null
  }, [shopIds, allowedLocationIds])
  // Summary numbers come from the daily rollup RPCs (get_sales_by_day / get_package_mix / get_product_mix / get_vehicle_makes — see
  // droptopRollups.ts): as of the last 8am/9am ET refresh, not live, and fast at any range, so there is no separate cache path any more. Shop
  // scope = summaryLocationIds (null = all shops). The Vehicle Make filter applies to these numbers; the Package/Product/Vehicle/Fleet/Oil
  // Only/Search filters still apply to order-level detail only, as before.
  const [vehicleMakes, setVehicleMakes] = useState<string[]>([])
  // Loads by itself (all shops unless some are picked), from the day-long cache when this period was loaded recently; see droptopRollups.ts.
  const rollups = useOrderRollups(!!companyId, {
    start: range.start, end: range.end, locationIds: summaryLocationIds, vehicleMakes,
  }, period !== 'custom' ? period : null)
  const summaryStats = useMemo(
    () => (rollups.data ? deriveSummary(rollups.data.sales, rollups.data.packageMix, rollups.data.productMix, packageClassification) : null),
    [rollups.data, packageClassification],
  )
  const summaryLoading = rollups.loading
  const summaryError = rollups.error
  const makeOptions = useMemo(() => (rollups.data?.makes ?? []).map((m) => ({ value: m.vehicle_make, count: m.orders })), [rollups.data])
  const rollupPackageOptions = useMemo(() => (rollups.data?.packageMix ?? []).map((m) => ({ value: m.package_name, count: m.packages_sold })).sort((a, b) => a.value.localeCompare(b.value)), [rollups.data])
  const rollupProductOptions = useMemo(() => (rollups.data?.productMix ?? []).map((m) => ({ value: m.product_id, count: Math.round(m.quantity) })).sort((a, b) => a.value.localeCompare(b.value)), [rollups.data])

  // Extracted out of what used to be the raw-fetch effect's own inline
  // body so the "Load data for this shop" quick-load (below, from the
  // report modal) can reuse the exact same fetch shape scoped to one
  // shop, without duplicating this whole pagination/retry pipeline.
  // Returns the parsed arrays rather than setting state directly — the
  // main effect below REPLACES state with them, the quick-load handler
  // MERGES them into what's already loaded.
  const fetchOrderDetailForScope = useCallback(async (
    locationIds: string[] | null,
    opts: { onProgress?: (loaded: number, total: number | null) => void; isCancelled?: () => boolean; signal?: AbortSignal } = {},
  ): Promise<{ orders: OrderRow[]; packages: PackageRow[]; products: ProductRow[]; services: ServiceRow[]; vehicles: VehicleRow[] }> => {
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`
    const cancelled = () => opts.isCancelled?.() ?? false

    function applyFilters(q: any) {
      q = q.eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
      if (locationIds?.length) q = q.in('location_id', locationIds)
      if (opts.signal) q = q.abortSignal(opts.signal)
      return q
    }

    // Real progress instead of an indeterminate spinner: a cheap COUNT-only
    // request (head:true — no rows returned, the count is computed
    // server-side) using the exact same filters as the real fetch below.
    // Best-effort — if it fails for any reason the load still proceeds,
    // just without a percentage.
    const { count } = await applyFilters(sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true }))
    if (!cancelled()) opts.onProgress?.(0, count ?? null)

    // Keyset pagination by (order_finalized_at, id), not plain id — a
    // cursor ordered by id while filtering on order_finalized_at can't use
    // an index to seek to the matching date range (see
    // 20260907_droptop_orders_date_index.sql), which is what made a narrow
    // custom range time out even though a wide one loaded fine.
    //
    // PAGE was briefly raised to 3000 to cut round trips, but this
    // Supabase project's API "Max Rows" setting silently caps EVERY
    // response at 1000 regardless of what .limit() requests. That alone
    // was harmless — the real bug was the loop's exit condition
    // (`batch.length < PAGE`) reading "server gave me fewer than I asked
    // for" as "that's the last page": with every response capped at 1000
    // and PAGE=3000, every page looked short, so the loop stopped after
    // page one and silently dropped everything past the first 1000 orders.
    // Fixed the exit condition to only stop on a genuinely EMPTY page,
    // which is correct regardless of whatever the real cap is now or
    // later, and reverted PAGE to 1000 to match the actual ceiling instead
    // of requesting more than will ever be honored.
    // Raised to 2000 (2026-09-03, Max Rows now 10,000) — kept more
    // conservative than the plain header-only fetches elsewhere in this
    // app since this query returns packages/products/services/vehicles per
    // order too (see OrderRowEmbedded above), so each page's payload is
    // heavier per row than a flat header fetch.
    const PAGE = 2000
    // A full company-wide range used to be 100+ SEQUENTIAL page requests —
    // correct, but every page waited on the previous one's round trip even
    // though the table can serve several requests at once.
    // fetchDateRangeConcurrent (src/lib) keeps this exact keyset-
    // pagination shape (still index-friendly on the date range, still safe
    // to retry a single page) but runs it across several non-overlapping
    // day-range slices in parallel instead of one loop covering the whole
    // range — see that file's own comment for why slicing by date rather
    // than plain OFFSET paging.
    const MAX_PAGE_RETRIES = 2
    let loadedSoFarLocal = 0
    // Header + every child table in ONE query per page — was a single
    // PostgREST resource-embed (ORDER_EMBED_SELECT) until 2026-09-24:
    // confirmed via EXPLAIN ANALYZE that a one-to-many embed like this
    // resolves as 4 separate CORRELATED subqueries run once PER OUTER ROW
    // (2000 executions each per page), most of them hitting disk — 4.6s
    // for a single 2000-row page, comfortably enough to blow the
    // `authenticated` role's 30s statement_timeout under this page's own
    // 6-way concurrent date-slice fetch on a large custom range (real
    // failure: "canceling statement due to statement timeout — loaded
    // 122,777 order(s)" on a ~230k-order pull). Replaced with the
    // get_droptop_orders_embedded RPC (migration 20260930bh), which does
    // the identical query as a bulk `WHERE order_id IN (...)` join per
    // child table instead of per-row lookups — confirmed 105ms for the
    // same page, ~44x faster. Same result shape (empty children read as
    // null exactly like the old embed), so nothing below this call needed
    // to change.
    const embedded = await fetchDateRangeConcurrent<OrderRowEmbedded>({
      rangeStart: range.start,
      rangeEnd: range.end,
      totalCount: count ?? null,
      cursorOf: (row) => ({ date: row.order_finalized_at ?? startIso, id: row.id }),
      isCancelled: cancelled,
      onProgress: (loadedSoFar) => { loadedSoFarLocal = loadedSoFar; if (!cancelled()) opts.onProgress?.(loadedSoFar, count ?? null) },
      fetchPage: async (subStart, subEnd, cursor) => {
        const subStartIso = `${subStart}T00:00:00.000Z`
        const subEndIso = `${subEnd}T23:59:59.999Z`
        let lastErr: string | null = null
        for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
          if (cancelled()) return []
          let call = sb.rpc('get_droptop_orders_embedded', {
            p_company_id: companyId,
            p_start: subStartIso,
            p_end: subEndIso,
            p_location_ids: locationIds?.length ? locationIds : null,
            p_cursor_date: cursor?.date ?? null,
            p_cursor_id: cursor?.id ?? null,
            p_limit: PAGE,
          })
          if (opts.signal) call = call.abortSignal(opts.signal)
          const { data: pageData, error: err } = await call
          if (!err) return (pageData ?? []) as OrderRowEmbedded[]
          lastErr = err.message
          if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
        throw new Error(`${lastErr ?? 'Failed to load orders'} — loaded ${loadedSoFarLocal.toLocaleString()} order(s) before this happened`)
      },
    })

    // Split the embedded response back into the flat header/child arrays
    // the rest of this file already works with (packagesByOrder etc. below
    // re-derive their own by-order Maps from these) — only the FETCH
    // strategy changed, not the downstream data shape.
    const allOrders: OrderRow[] = []
    const pkgRows: PackageRow[] = []
    const prodRows: ProductRow[] = []
    const svcRows: ServiceRow[] = []
    const vehRows: VehicleRow[] = []
    for (const o of embedded) {
      const { droptop_order_packages, droptop_order_products, droptop_order_services, droptop_order_vehicles, ...header } = o
      allOrders.push(header)
      for (const p of droptop_order_packages ?? []) pkgRows.push({ order_id: o.id, ...p })
      for (const p of droptop_order_products ?? []) prodRows.push({ order_id: o.id, ...p })
      for (const s of droptop_order_services ?? []) svcRows.push({ order_id: o.id, ...s })
      for (const v of droptop_order_vehicles ?? []) vehRows.push({ order_id: o.id, ...v })
    }
    return { orders: allOrders, packages: pkgRows, products: prodRows, services: svcRows, vehicles: vehRows }
  }, [companyId, range.start, range.end])

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
    // The raw per-order+package+product+service+vehicle fetch only runs
    // once the user explicitly asks for order-level detail (see
    // detailRequested above and its "Load Order Detail" button below) —
    // the stats cards above already come from the fast summary RPC
    // without it. Found live 2026-09-24: a real 170k-order/30-day range
    // took 4 minutes here specifically because this fetch used to run
    // automatically just to feed those same stats cards.
    if (!detailRequested) {
      setOrders([]); setPackages([]); setProducts([]); setServices([]); setVehicles([])
      setLoading(false); setError(null)
      return
    }
    let cancelled = false
    // Direct investigation 2026-10-01: a real "narrow custom range, one
    // shop" fetch timed out even though the identical query ran in ~2s via
    // EXPLAIN ANALYZE in isolation — the count query and every page's RPC
    // call below had no AbortController wired up at all, so switching the
    // date range/shop picker while a broader fetch was still in flight
    // (very plausible — this is exactly the sequence that led to the
    // reported timeout) never actually cancelled the ABANDONED request
    // server-side, only stopped this component from listening to it. The
    // old fetch kept running to completion (up to its own 60s function
    // timeout) in parallel with the new one, competing for the same
    // connection pool/disk cache — a self-inflicted contention source this
    // page could hit on its own. An AbortController now actually cancels
    // the previous request's underlying HTTP call the instant the scope
    // changes, so at most one of this page's own detail fetches is ever
    // genuinely running against the DB at a time.
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    setLoadProgress({ loaded: 0, total: null })
    fetchOrderDetailForScope(shopIds.length ? shopIds : null, {
      isCancelled: () => cancelled,
      onProgress: (loaded, total) => { if (!cancelled) setLoadProgress({ loaded, total }) },
      signal: controller.signal,
    }).then((result) => {
      if (cancelled) return
      setOrders(result.orders)
      setPackages(result.packages)
      setProducts(result.products)
      setServices(result.services)
      setVehicles(result.vehicles)
      setLoading(false)
    }).catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true; controller.abort() }
  }, [companyId, range.start, range.end, shopIds.join(','), loadAllShops, detailRequested, fetchOrderDetailForScope])

  // "Load data for this shop" quick-load (Build Your Own Report modal,
  // direct feedback 2026-09-24: clicking a By Shop row before order-level
  // detail is loaded opens a report with nothing in it, "which makes
  // sense... but it would be nice to have a button... to quickly pull the
  // data for that shop") — a scoped, one-shop fetch that MERGES into
  // whatever's already loaded rather than requiring the full "Load Order
  // Detail" pull for the page's entire scope. Reads `orders` from the
  // closure (not a functional updater) since this is a discrete,
  // user-triggered one-off action, not a hot render path.
  const [shopQuickLoading, setShopQuickLoading] = useState<string | null>(null)
  async function loadShopQuickly(locationId: string) {
    setShopQuickLoading(locationId)
    try {
      const result = await fetchOrderDetailForScope([locationId])
      const seen = new Set(orders.map((o) => o.id))
      const newOrders = result.orders.filter((o) => !seen.has(o.id))
      const newOrderIds = new Set(newOrders.map((o) => o.id))
      setOrders((prev) => [...prev, ...newOrders])
      setPackages((prev) => [...prev, ...result.packages.filter((p) => newOrderIds.has(p.order_id))])
      setProducts((prev) => [...prev, ...result.products.filter((p) => newOrderIds.has(p.order_id))])
      setServices((prev) => [...prev, ...result.services.filter((s) => newOrderIds.has(s.order_id))])
      setVehicles((prev) => [...prev, ...result.vehicles.filter((v) => newOrderIds.has(v.order_id))])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load data for this shop')
    } finally {
      setShopQuickLoading(null)
    }
  }

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
  // Year/Make/Model when Droptop's VIN decode succeeded, falling back
  // through vehicle_name/license_plate/vin — shared by the report column,
  // the Vehicle filter dropdown, and its option counts, so all three treat
  // "the same vehicle" identically.
  function vehicleBaseLabel(v: VehicleRow): string {
    const yearMakeModel = [v.vin_vehicle_year, v.vin_vehicle_make, v.vin_vehicle_model].filter(Boolean).join(' ')
    return yearMakeModel || v.vehicle_name || v.license_plate || v.vin || '—'
  }
  function vehicleLabelFor(orderId: string): string {
    const vs = vehiclesByOrder.get(orderId) ?? []
    if (!vs.length) return '—'
    return vs.map((v) => {
      const base = vehicleBaseLabel(v)
      return v.mileage != null ? `${base} — ${Math.round(v.mileage).toLocaleString()} mi` : base
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
  const detailPackageOptions = useMemo(
    () => allPackageNames.map((n) => ({ value: n, count: packageOptionCounts.get(n) ?? 0 })),
    [allPackageNames, packageOptionCounts],
  )
  // Before order detail is loaded the choices come from the summary rollups, so Package / Product ID can be picked right away.
  const packageOptions = packages.length ? detailPackageOptions : rollupPackageOptions

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
  const detailProductIdOptions = useMemo(
    () => allProductIds.map((id) => ({ value: id, count: productIdOptionCounts.get(id) ?? 0 })),
    [allProductIds, productIdOptionCounts],
  )
  const productIdOptions = allProductIds.length ? detailProductIdOptions : rollupProductOptions

  // Fleet names actually present on a loaded order — same derivation shape
  // as allPackageNames/allProductIds above.
  const allFleetNames = useMemo(
    () => [...new Set(orders.map((o) => o.fleet_company_name).filter((n): n is string => !!n))].sort(),
    [orders],
  )
  const fleetOptionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) if (o.fleet_company_name) m.set(o.fleet_company_name, (m.get(o.fleet_company_name) ?? 0) + 1)
    return m
  }, [orders])
  const fleetOptions = useMemo(
    () => allFleetNames.map((n) => ({ value: n, count: fleetOptionCounts.get(n) ?? 0 })),
    [allFleetNames, fleetOptionCounts],
  )

  // Vehicle Make comes from the summary rollup (see makeOptions); Model and Year are read from the loaded order detail, so they stay empty until
  // detail is loaded. (They used to be one slow "Vehicle" dropdown of every year/make/model combination.)
  const vehicleAttrsByOrder = useMemo(() => {
    const m = new Map<string, { makes: Set<string>; models: Set<string>; years: Set<string> }>()
    for (const v of vehicles) {
      const a = m.get(v.order_id) ?? { makes: new Set<string>(), models: new Set<string>(), years: new Set<string>() }
      if (v.vin_vehicle_make) a.makes.add(v.vin_vehicle_make.toLowerCase())
      if (v.vin_vehicle_model) a.models.add(v.vin_vehicle_model)
      if (v.vin_vehicle_year != null) a.years.add(String(v.vin_vehicle_year))
      m.set(v.order_id, a)
    }
    return m
  }, [vehicles])
  const vehicleModelOptions = useMemo(() => {
    const c = new Map<string, number>()
    for (const v of vehicles) {
      if (!v.vin_vehicle_model) continue
      if (vehicleMakes.length && !vehicleMakes.some((mk) => mk.toLowerCase() === (v.vin_vehicle_make ?? '').toLowerCase())) continue
      c.set(v.vin_vehicle_model, (c.get(v.vin_vehicle_model) ?? 0) + 1)
    }
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }))
  }, [vehicles, vehicleMakes])
  const vehicleYearOptions = useMemo(() => {
    const c = new Map<string, number>()
    for (const v of vehicles) if (v.vin_vehicle_year != null) c.set(String(v.vin_vehicle_year), (c.get(String(v.vin_vehicle_year)) ?? 0) + 1)
    return [...c.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).map(([value, count]) => ({ value, count }))
  }, [vehicles])

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
      if (vehicleMakes.length || vehicleModels.length || vehicleYears.length) {
        const a = vehicleAttrsByOrder.get(o.id)
        if (!a) return false
        if (vehicleMakes.length && !vehicleMakes.some((m) => a.makes.has(m.toLowerCase()))) return false
        if (vehicleModels.length && !vehicleModels.some((m) => a.models.has(m))) return false
        if (vehicleYears.length && !vehicleYears.some((y) => a.years.has(y))) return false
      }
      if (fleetFilters.length && !(o.fleet_company_name && fleetFilters.includes(o.fleet_company_name))) return false
      if (oilOnly && quartsFor(o.id) === 0) return false
      if (q) {
        const hay = `${o.order_id} ${o.first_name ?? ''} ${o.last_name ?? ''} ${o.city ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [orders, packagesByOrder, productsByOrder, servicesByOrder, vehicleAttrsByOrder, search, packageFilters, productIdFilters, vehicleMakes, vehicleModels, vehicleYears, fleetFilters, oilOnly, allowedLocationIds])

  const filteredOrderIds = useMemo(() => new Set(filteredOrders.map((o) => o.id)), [filteredOrders])

  // Orders table — converted onto this app's standard useTable/DataTable/
  // useColumnPrefs/ColumnManagerModal stack (direct ask 2026-09-30, "same
  // table design as the new Orders v2 beta table... Manage Columns so we
  // can manage and pin columns as desired") — replaces the previous
  // hand-rolled <table> + manual Prev/Next pagination. DataTable's own
  // TanStack pagination already only renders one page's worth of rows at a
  // time, so this keeps the exact same "don't render tens of thousands of
  // rows at once" property the old manual pagination existed for.
  const ORDERS_TABLE_KEY = 'droptop_orders.orders_table'
  const orderCol = useMemo(() => createColumnHelper<OrderRow>(), [])
  const orderColumns = useMemo(() => [
    orderCol.accessor('order_id', { id: 'order_id', header: 'Order #' }),
    orderCol.accessor((o) => (o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—'), { id: 'shop', header: 'Shop' }),
    // Direct ask 2026-10-01: "Manage Columns" only ever offered this table's
    // own fixed 12 columns, so Region/Base Service Price/M5%/Subtotal were
    // only reachable via Build Your Own Report — added here too, same
    // getters as DETAIL_COLUMNS below, so both column pools genuinely match.
    orderCol.accessor((o) => o.region || '—', { id: 'region', header: 'Region' }),
    orderCol.accessor((o) => [o.first_name, o.last_name].filter(Boolean).join(' ') || '—', { id: 'customer', header: 'Customer' }),
    orderCol.accessor('city', { id: 'city', header: 'City', cell: (i) => i.getValue() || '—' }),
    orderCol.accessor('status', { id: 'status', header: 'Status', cell: (i) => i.getValue() || '—' }),
    // Packages / Base Service Price / Products carry several values per order, so their filters list each UNIQUE value (not the comma
    // combinations) with a search box; Quarts has the greater-than / less-than / between number filter.
    orderCol.accessor((o) => (packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter(Boolean).join(', ') || '—', {
      id: 'packages', header: 'Packages', enableSorting: false,
      meta: { multiValue: (o: OrderRow) => (packagesByOrder.get(o.id) ?? []).map((p) => p.name).filter((n): n is string => !!n) },
    }),
    orderCol.accessor((o) => (packagesByOrder.get(o.id) ?? []).map((p) => p.base_service_price != null ? money(p.base_service_price) : null).filter(Boolean).join(', ') || '—', {
      id: 'base_price', header: 'Base Service Price', enableSorting: false,
      cell: (i) => <span className="block text-right">{i.getValue()}</span>,
      meta: { multiValue: (o: OrderRow) => (packagesByOrder.get(o.id) ?? []).map((p) => (p.base_service_price != null ? money(p.base_service_price) : null)).filter((v): v is string => !!v) },
    }),
    orderCol.accessor((o) => productIdsFor(o.id).join(', ') || '—', {
      id: 'products', header: 'Products', enableSorting: false,
      meta: { multiValue: (o: OrderRow) => productIdsFor(o.id) },
    }),
    orderCol.accessor((o) => quartsFor(o.id), {
      id: 'quarts', header: 'Quarts',
      cell: (i) => { const q = i.getValue(); return <span className="block text-right">{q > 0 ? q.toFixed(2) : '—'}</span> },
      meta: { numeric: true },
    }),
    orderCol.display({
      id: 'm5_pct', header: 'M5%', enableSorting: false,
      cell: (i) => { const c = classificationCountsFor(i.row.original.id); return <span className="block text-right">{c.oilChange > 0 ? `${((c.m5 / c.oilChange) * 100).toFixed(1)}%` : 'N/A'}</span> },
    }),
    orderCol.display({
      id: 'vehicle', header: 'Vehicle', enableSorting: false,
      cell: (i) => vehicleLabelFor(i.row.original.id),
    }),
    orderCol.accessor('fleet_company_name', { id: 'fleet', header: 'Fleet', cell: (i) => i.getValue() || '—' }),
    orderCol.accessor('subtotal', { id: 'subtotal', header: 'Subtotal', cell: (i) => <span className="block text-right">{money(i.getValue())}</span> }),
    orderCol.accessor('final_price', { id: 'total', header: 'Total', cell: (i) => <span className="block text-right">{money(i.getValue())}</span> }),
    orderCol.accessor((o) => (o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—'), { id: 'finalized', header: 'Finalized' }),
  ], [orderCol, idToLabel, packagesByOrder]) // eslint-disable-line react-hooks/exhaustive-deps

  const {
    table: ordersTable, globalFilter: ordersFilter, setGlobalFilter: setOrdersFilter,
    columnVisibility: ordersColVis, columnOrder: ordersColOrder, setColumnOrder: setOrdersColOrder,
    columnPinning: ordersColPinning, setColumnPinning: setOrdersColPinning,
  } = useTable(filteredOrders, orderColumns, {
    persistKey: ORDERS_TABLE_KEY,
    initialPageSize: 100,
    initialSorting: [{ id: 'finalized', desc: true }],
    initialColumnPinning: { left: ['order_id'], right: [] },
  })
  useColumnPrefs(ORDERS_TABLE_KEY, ordersTable, ordersColVis, ordersColOrder, setOrdersColOrder)
  const [ordersColumnManagerOpen, setOrdersColumnManagerOpen] = useState(false)
  const ordersAllColItems: ColItem[] = useMemo(
    () => ordersTable.getAllLeafColumns().map((c) => ({ id: c.id, label: String(c.columnDef.header ?? c.id) })),
    [ordersTable],
  )
  const ordersShownOrder = useMemo(() => {
    const ids = ordersTable.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!ordersColOrder.length) return ids
    const known = ordersColOrder.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !known.includes(id))]
  }, [ordersTable, ordersColOrder])
  function applyOrdersShownColumns(shown: string[]) {
    setOrdersColOrder(shown)
    const vis: Record<string, boolean> = {}
    for (const c of ordersAllColItems) vis[c.id] = shown.includes(c.id)
    ordersTable.setColumnVisibility(vis)
  }
  function resetOrdersColumns() {
    setOrdersColOrder([])
    ordersTable.setColumnVisibility({})
    ordersTable.setColumnSizing({})
    setOrdersColPinning({ left: ['order_id'], right: [] })
  }

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

  // M5% = count of M5-classified packages (Air Filter, Cabin Air Filter,
  // Wiper Blade Replacement, Additives, Tire Rotation) ÷ count of Oil
  // Change-classified packages, both from Package Mapping's classification
  // — a package-line-item count, not an order count, since one order can
  // carry more than one of either (an oil change plus a tire rotation on
  // the same visit is 1 oil-change package and 1 M5 package, not "1
  // order").
  function classificationCountsFor(orderId: string): { m5: number; oilChange: number } {
    let m5 = 0, oilChange = 0
    for (const p of packagesByOrder.get(orderId) ?? []) {
      if (!p.name) continue
      const c = packageClassification.get(p.name)
      if (c && isM5(c)) m5++
      else if (c === 'oil_change') oilChange++
    }
    return { m5, oilChange }
  }

  const totals = useMemo(() => {
    const revenue = filteredOrders.reduce((sum, o) => sum + (o.final_price ?? 0), 0)
    // Average quarts per order, counting only orders that actually had a
    // quart-uom (oil-change) product on them — an order with no oil at all
    // (a tire rotation, a filter-only visit) would just drag this toward
    // zero rather than answer "for the oil changes we did, how much oil".
    let oilOrderCount = 0, oilQuartsTotal = 0
    let m5Count = 0, oilChangeCount = 0
    for (const o of filteredOrders) {
      const q = quartsFor(o.id)
      if (q > 0) { oilOrderCount++; oilQuartsTotal += q }
      const c = classificationCountsFor(o.id)
      m5Count += c.m5
      oilChangeCount += c.oilChange
    }
    return {
      count: filteredOrders.length,
      revenue,
      avgOrderValue: filteredOrders.length ? revenue / filteredOrders.length : 0,
      avgQuartsPerOilOrder: oilOrderCount ? oilQuartsTotal / oilOrderCount : 0,
      oilOrderCount,
      m5Count,
      oilChangeCount,
      m5Pct: oilChangeCount > 0 ? (m5Count / oilChangeCount) * 100 : null,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, productsByOrder, servicesByOrder, packagesByOrder, packageClassification])

  // Shop-level rollup: how many orders per shop, and (of the ones that
  // included an oil-change product) the average quarts per order — same
  // "only count orders that actually had oil" reasoning as totals above,
  // just broken out by shop instead of company-wide.
  const shopStats = useMemo(() => {
    const stats = new Map<string, { count: number; oilOrderCount: number; oilQuartsTotal: number; m5Count: number; oilChangeCount: number }>()
    for (const o of filteredOrders) {
      const key = o.location_id ?? '—'
      const s = stats.get(key) ?? { count: 0, oilOrderCount: 0, oilQuartsTotal: 0, m5Count: 0, oilChangeCount: 0 }
      s.count++
      const q = quartsFor(o.id)
      if (q > 0) { s.oilOrderCount++; s.oilQuartsTotal += q }
      const c = classificationCountsFor(o.id)
      s.m5Count += c.m5
      s.oilChangeCount += c.oilChange
      stats.set(key, s)
    }
    return [...stats.entries()]
      .map(([locationId, s]) => ({
        locationId,
        shopLabel: locationId === '—' ? '—' : (idToLabel.get(locationId) ?? locationId),
        count: s.count,
        avgQuarts: s.oilOrderCount ? s.oilQuartsTotal / s.oilOrderCount : 0,
        m5Pct: s.oilChangeCount > 0 ? (s.m5Count / s.oilChangeCount) * 100 : null,
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrders, productsByOrder, servicesByOrder, idToLabel, packagesByOrder, packageClassification])

  // Whichever the stats cards below actually render: the fast SQL summary
  // until full order-level detail has actually FINISHED loading, then the
  // client-computed totals/packageStats/shopStats above — which correctly
  // reflect the ad-hoc Package/Product/Vehicle/Fleet/Oil-Only/Search
  // filters the summary RPC deliberately doesn't replicate (see that RPC's
  // own migration comment). Found live 2026-09-24: clicking "Load Order
  // Detail"/"Load All Shops" used to switch to the client versions the
  // instant detailRequested went true, while `orders` was still empty
  // (freshly reset for the raw fetch) — the whole summary section
  // visibly zeroed out for the duration of the raw fetch instead of
  // staying on the already-loaded fast numbers. Keeping `loading` in this
  // condition means the summary only steps aside once there's real
  // client-side data to replace it with.
  const useSummaryStats = !detailRequested || loading
  const effectiveTotals = useSummaryStats && summaryStats
    ? {
        count: summaryStats.totals.count,
        revenue: summaryStats.totals.revenue,
        avgOrderValue: summaryStats.totals.avg_order_value,
        avgQuartsPerOilOrder: summaryStats.totals.avg_quarts_per_oil_order,
        m5Pct: summaryStats.totals.m5_pct,
      }
    : totals
  // The rollups carry packages sold and revenue (not avg oil quarts per package); once order detail loads the client numbers show avg oil instead.
  const effectivePackageStats = useSummaryStats && summaryStats
    ? summaryStats.by_package.map((p) => ({ name: p.name, count: p.sold, avgOilQuarts: 0, revenue: p.revenue as number | null }))
    : packageStats.map((p) => ({ ...p, revenue: null as number | null }))
  // Per-shop avg quarts / M5% aren't in the rollups (package mix isn't broken out by shop), so the summary view shows orders + revenue instead.
  const effectiveShopStats = useSummaryStats && summaryStats
    ? summaryStats.by_shop
        .map((s) => ({
          locationId: s.location_id ?? '—',
          shopLabel: s.location_id ? (idToLabel.get(s.location_id) ?? s.location_id) : '—',
          count: s.count,
          avgQuarts: 0,
          m5Pct: null as number | null,
          revenue: s.revenue as number | null,
        }))
        .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    : shopStats.map((s) => ({ ...s, revenue: null as number | null }))

  // ---- By Shop / By Package tables (the standard DataTable) -----------------------------------------------------------
  // Summary view: orders + revenue from the rollups, with oil changes / M5% / avg quarts from the per-shop stats call (arrives a moment later).
  // Once order detail is loaded the client-computed numbers take over (they respect the Package/Product/Vehicle/Search filters).
  const shopStatsById = useMemo(() => new Map((rollups.shopStats ?? []).map((r) => [r.location_id, r])), [rollups.shopStats])
  const revenueByLocation = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of filteredOrders) m.set(o.location_id ?? '—', (m.get(o.location_id ?? '—') ?? 0) + (o.final_price ?? 0))
    return m
  }, [filteredOrders])
  const shopRows = useMemo<ShopRow[]>(() => {
    if (useSummaryStats && summaryStats) {
      const total = summaryStats.totals.revenue
      return summaryStats.by_shop.map((x) => {
        const st = shopStatsById.get(x.location_id)
        return {
          id: x.location_id ?? '—', locationId: x.location_id ?? '—',
          shopLabel: x.location_id ? (idToLabel.get(x.location_id) ?? x.location_id) : '—',
          orders: x.count, revenue: x.revenue, avgTicket: x.count > 0 ? x.revenue / x.count : null,
          revShare: total > 0 ? (x.revenue / total) * 100 : null,
          oilChanges: st ? st.oil_packages : null,
          m5Pct: st && st.oil_packages > 0 ? (st.m5_packages / st.oil_packages) * 100 : null,
          avgQuarts: st && st.oil_packages > 0 ? st.quarts / st.oil_packages : null,
        }
      }).sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    }
    const total = filteredOrders.reduce((n, o) => n + (o.final_price ?? 0), 0)
    return shopStats.map((x) => {
      const rev = revenueByLocation.get(x.locationId) ?? 0
      return { id: x.locationId, locationId: x.locationId, shopLabel: x.shopLabel, orders: x.count, revenue: rev, avgTicket: x.count > 0 ? rev / x.count : null, revShare: total > 0 ? (rev / total) * 100 : null, oilChanges: null, m5Pct: x.m5Pct, avgQuarts: x.avgQuarts > 0 ? x.avgQuarts : null }
    })
  }, [useSummaryStats, summaryStats, shopStatsById, idToLabel, shopStats, filteredOrders, revenueByLocation])
  const kindOf = useCallback((name: string) => { const c = packageClassification.get(name); return c === 'oil_change' ? 'Oil Change' : c && isM5(c) ? 'M5' : '—' }, [packageClassification])
  const revenueByPackage = useMemo(() => {
    const m = new Map<string, number>()
    for (const pk of packages) if (pk.name && filteredOrderIds.has(pk.order_id)) m.set(pk.name, (m.get(pk.name) ?? 0) + (pk.price_total_after_discount ?? pk.price_total ?? 0))
    return m
  }, [packages, filteredOrderIds])
  const packageRows = useMemo<PackageRow2[]>(() => {
    if (useSummaryStats && summaryStats) {
      const sold = summaryStats.by_package.reduce((n, x) => n + x.sold, 0), rev = summaryStats.by_package.reduce((n, x) => n + x.revenue, 0)
      return summaryStats.by_package.map((x) => ({ id: x.name, name: x.name, kind: kindOf(x.name), orders: x.orders, sold: x.sold, revenue: x.revenue, avgPrice: x.sold > 0 ? x.revenue / x.sold : null, soldShare: sold > 0 ? (x.sold / sold) * 100 : null, revShare: rev > 0 ? (x.revenue / rev) * 100 : null, avgOilQuarts: null }))
    }
    const sold = packageStats.reduce((n, x) => n + x.count, 0), rev = [...revenueByPackage.values()].reduce((n, v) => n + v, 0)
    return packageStats.map((x) => {
      const r = revenueByPackage.get(x.name) ?? 0
      return { id: x.name, name: x.name, kind: kindOf(x.name), orders: x.count, sold: x.count, revenue: r, avgPrice: x.count > 0 ? r / x.count : null, soldShare: sold > 0 ? (x.count / sold) * 100 : null, revShare: rev > 0 ? (r / rev) * 100 : null, avgOilQuarts: x.avgOilQuarts > 0 ? x.avgOilQuarts : null }
    })
  }, [useSummaryStats, summaryStats, packageStats, revenueByPackage, kindOf])

  const shopCol = useMemo(() => createColumnHelper<ShopRow>(), [])
  const pctCell = (v: number | null) => <span className="block text-right">{v == null ? '—' : `${v.toFixed(1)}%`}</span>
  const numCell = (v: number | null, d = 0) => <span className="block text-right">{v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })}</span>
  const pendingCell = (v: number | null, render: (n: number) => string) => (
    <span className="block text-right">{v != null ? render(v) : useSummaryStats && rollups.shopStatsLoading ? '…' : '—'}</span>
  )
  const shopColumns = useMemo(() => [
    shopCol.accessor('shopLabel', { id: 'shop', header: 'Shop', cell: (i) => <span className="underline decoration-dotted whitespace-nowrap">{i.getValue()}</span> }),
    shopCol.accessor('orders', { id: 'orders', header: 'Orders', cell: (i) => numCell(i.getValue()), meta: { numeric: true } }),
    shopCol.accessor((r) => r.revenue ?? 0, { id: 'revenue', header: 'Revenue', cell: (i) => <span className="block text-right">{money(i.getValue())}</span>, meta: { numeric: true } }),
    shopCol.accessor((r) => r.avgTicket ?? 0, { id: 'avg_ticket', header: 'Avg Ticket', cell: (i) => <span className="block text-right">{money(i.getValue())}</span>, meta: { numeric: true } }),
    shopCol.accessor((r) => r.revShare ?? 0, { id: 'rev_share', header: '% of Revenue', cell: (i) => pctCell(i.getValue()), meta: { numeric: true } }),
    shopCol.accessor((r) => r.oilChanges ?? 0, { id: 'oil_changes', header: 'Oil Changes', cell: (i) => pendingCell(i.row.original.oilChanges, (n) => n.toLocaleString()), meta: { numeric: true } }),
    shopCol.accessor((r) => r.m5Pct ?? 0, { id: 'm5', header: 'M5%', cell: (i) => pendingCell(i.row.original.m5Pct, (n) => `${n.toFixed(1)}%`), meta: { numeric: true } }),
    shopCol.accessor((r) => r.avgQuarts ?? 0, { id: 'avg_quarts', header: 'Avg Quarts / Oil Change', cell: (i) => pendingCell(i.row.original.avgQuarts, (n) => n.toFixed(2)), meta: { numeric: true } }),
  ], [shopCol, useSummaryStats, rollups.shopStatsLoading]) // eslint-disable-line react-hooks/exhaustive-deps
  const { table: shopTable, globalFilter: shopFilter, setGlobalFilter: setShopFilter, columnVisibility: shopColVis, columnOrder: shopColOrder, setColumnOrder: setShopColOrder } = useTable(shopRows, shopColumns, { persistKey: 'droptop_orders.by_shop', initialPageSize: 25, initialSorting: [{ id: 'orders', desc: true }] })
  useColumnPrefs('droptop_orders.by_shop', shopTable, shopColVis, shopColOrder, setShopColOrder)

  const pkgCol = useMemo(() => createColumnHelper<PackageRow2>(), [])
  const packageColumns = useMemo(() => [
    pkgCol.accessor('name', { id: 'package', header: 'Package' }),
    pkgCol.accessor('kind', { id: 'kind', header: 'Type' }),
    pkgCol.accessor('sold', { id: 'sold', header: 'Packages Sold', cell: (i) => numCell(i.getValue()), meta: { numeric: true } }),
    pkgCol.accessor('orders', { id: 'orders', header: 'Orders', cell: (i) => numCell(i.getValue()), meta: { numeric: true } }),
    pkgCol.accessor((r) => r.revenue ?? 0, { id: 'revenue', header: 'Revenue', cell: (i) => <span className="block text-right">{money(i.getValue())}</span>, meta: { numeric: true } }),
    pkgCol.accessor((r) => r.avgPrice ?? 0, { id: 'avg_price', header: 'Avg Price', cell: (i) => <span className="block text-right">{money(i.getValue())}</span>, meta: { numeric: true } }),
    pkgCol.accessor((r) => r.soldShare ?? 0, { id: 'sold_share', header: '% of Packages', cell: (i) => pctCell(i.getValue()), meta: { numeric: true } }),
    pkgCol.accessor((r) => r.revShare ?? 0, { id: 'rev_share', header: '% of Revenue', cell: (i) => pctCell(i.getValue()), meta: { numeric: true } }),
    pkgCol.accessor((r) => r.avgOilQuarts ?? 0, { id: 'avg_oil', header: 'Avg Oil (Qts)', cell: (i) => <span className="block text-right" title={useSummaryStats ? 'Per-package oil quarts come with order detail' : undefined}>{i.row.original.avgOilQuarts != null ? i.row.original.avgOilQuarts.toFixed(2) : '—'}</span>, meta: { numeric: true } }),
  ], [pkgCol, useSummaryStats]) // eslint-disable-line react-hooks/exhaustive-deps
  const { table: pkgTable, globalFilter: pkgFilter, setGlobalFilter: setPkgFilter, columnVisibility: pkgColVis, columnOrder: pkgColOrder, setColumnOrder: setPkgColOrder } = useTable(packageRows, packageColumns, { persistKey: 'droptop_orders.by_package', initialPageSize: 25, initialSorting: [{ id: 'sold', desc: true }] })
  useColumnPrefs('droptop_orders.by_package', pkgTable, pkgColVis, pkgColOrder, setPkgColOrder)

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
  // Order detail modal — direct ask 2026-10-01: clicking an order row shows
  // everything already loaded for it (every DETAIL_COLUMNS field, reusing
  // the exact same getters) without having to widen the table or scroll
  // right to see columns that aren't currently shown.
  const [viewingOrder, setViewingOrder] = useState<OrderRow | null>(null)
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
    {
      // The package's own base_service_price (list price before
      // coupons/discounts) — for auditing that what Droptop actually sold
      // matches core.locations' configured price columns. Joined in the
      // same order as the Packages column above so the two line up
      // side-by-side for an order with more than one package.
      key: 'base_price', label: 'Base Service Price', align: 'right',
      get: (o) => (packagesByOrder.get(o.id) ?? []).map((p) => p.base_service_price != null ? money(p.base_service_price) : null).filter(Boolean).join(', ') || '—',
    },
    { key: 'products', label: 'Products', get: (o) => productIdsFor(o.id).join(', ') || '—' },
    { key: 'quarts', label: 'Quarts', get: (o) => { const q = quartsFor(o.id); return q > 0 ? q.toFixed(2) : '—' }, align: 'right' },
    {
      // Per-order M5% — same formula as the company/shop-level stat (M5
      // package line items ÷ Oil Change package line items on THIS one
      // order), not "does this order have an M5 package" — an order with 2
      // M5 items and 1 oil change reads as 200%, matching how the
      // aggregate stat would treat the same mix. N/A (not 0%) when the
      // order has no oil-change package at all, since dividing by zero
      // isn't "no M5 sold," it's "this ratio doesn't apply to this order."
      key: 'm5_pct', label: 'M5%', align: 'right',
      get: (o) => { const c = classificationCountsFor(o.id); return c.oilChange > 0 ? `${((c.m5 / c.oilChange) * 100).toFixed(1)}%` : 'N/A' },
    },
    { key: 'vehicle', label: 'Vehicle', get: (o) => vehicleLabelFor(o.id) },
    { key: 'fleet', label: 'Fleet', get: (o) => o.fleet_company_name || '—' },
    { key: 'subtotal', label: 'Subtotal', get: (o) => money(o.subtotal), align: 'right' },
    { key: 'total', label: 'Total', get: (o) => money(o.final_price), align: 'right' },
    { key: 'finalized', label: 'Finalized', get: (o) => (o.order_finalized_at ? new Date(o.order_finalized_at).toLocaleDateString() : '—') },
  ]
  const [reportColumnKeys, setReportColumnKeys] = useState<string[]>(['order_id', 'shop', 'customer', 'packages', 'base_price', 'quarts', 'm5_pct', 'total', 'finalized'])
  const [reportRegions, setReportRegions] = useState<string[]>([])
  const [reportMarkets, setReportMarkets] = useState<string[]>([])
  const [reportAMs, setReportAMs] = useState<string[]>([])
  const [reportShops, setReportShops] = useState<string[]>([])
  const [reportExporting, setReportExporting] = useState<'csv' | 'xlsx' | null>(null)
  // The modal's on-screen preview was rendering every matching order as a
  // real DOM row with no cap at all (unlike the main Orders table, which
  // has always paginated) — on a big pull that's thousands of <tr>s built
  // synchronously the moment the modal opens, and torn down again the
  // moment it closes. That's what the reported open/close lag actually
  // was. Copy/Export still work against the FULL reportOrders/
  // reportTotalsRows below, unaffected — only what's actually painted to
  // the screen is capped.
  const REPORT_PAGE_SIZE = 100
  const [reportPage, setReportPage] = useState(0)

  const reportShopLabelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  // Powers the "Load Data for This Shop" quick-load button below — only
  // meaningful in single-shop detail mode (the shape a By Shop row click
  // opens), and only worth offering when that shop genuinely has no
  // orders loaded yet (a legitimately zero-order shop would show the
  // button forever, harmless but not worth special-casing).
  const singleReportShopId = reportMode === 'detail' && reportShops.length === 1 ? (reportShopLabelToId.get(reportShops[0]) ?? null) : null
  const singleReportShopHasData = singleReportShopId ? orders.some((o) => o.location_id === singleReportShopId) : true
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
    // loc.byId/loc.fieldValue (not the whole `loc` object) — useLocations()
    // now gives these stable identity via useCallback, so this only
    // recomputes when locations data or the filters actually change.
  }, [filteredOrders, reportRegions, reportMarkets, reportAMs, reportShops, reportShopLabelToId, loc.byId, loc.fieldValue])

  interface ShopTotalsRow { shopLabel: string; orders: number; subtotal: number; total: number; quarts: number; packages: number }
  const TOTALS_COLUMNS: { key: string; label: string; get: (r: ShopTotalsRow) => string; align?: 'right' }[] = [
    { key: 'shop', label: 'Shop', get: (r) => r.shopLabel },
    { key: 'orders', label: 'Orders', get: (r) => r.orders.toLocaleString(), align: 'right' },
    { key: 'packages', label: 'Packages', get: (r) => r.packages.toLocaleString(), align: 'right' },
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

  // Paged view for the modal's on-screen table only — see REPORT_PAGE_SIZE
  // comment above. Copy/export read reportOrders/reportTotalsRows directly.
  const reportPageCount = Math.max(1, Math.ceil((reportMode === 'detail' ? reportOrders.length : reportTotalsRows.length) / REPORT_PAGE_SIZE))
  const pagedReportOrders = useMemo(
    () => reportOrders.slice(reportPage * REPORT_PAGE_SIZE, (reportPage + 1) * REPORT_PAGE_SIZE),
    [reportOrders, reportPage],
  )
  const pagedReportTotalsRows = useMemo(
    () => reportTotalsRows.slice(reportPage * REPORT_PAGE_SIZE, (reportPage + 1) * REPORT_PAGE_SIZE),
    [reportTotalsRows, reportPage],
  )
  // Reset to page 1 whenever the report's own filters/mode change the
  // underlying result set, so the user doesn't land on a now-empty page.
  useEffect(() => {
    setReportPage(0)
  }, [reportMode, reportRegions, reportMarkets, reportAMs, reportShops])

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

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Droptop Orders</h1>
          <p className="text-xs text-inky mt-0.5">
            Search, filter, and summarize synced orders. Populated by Config → Data Connections' Droptop — Orders sync.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <DataCompletenessBadge connectionKey="droptop_orders" />
          {(
            <span className="text-[10px] font-mono text-inky/70" title="The summary reads daily rollups refreshed at 8am and 9am ET — it isn't live.">
              {summaryStats?.dataThrough ? `Data through ${summaryStats.dataThrough}` : summaryStats ? 'No orders in this range' : ''}
              {summaryLoading && summaryStats ? ' · updating…' : ''}
            </span>
          )}
        </div>
      </div>

      {/* Filters — Region/Market/AM/Shop(s) first (narrows top-down), then
          what-was-sold (Package/Product/Oil), then who/what vehicle
          (Vehicle/Fleet), then free-text Search last. The "Showing All
          Shops" chip that used to sit here was removed — the Shop(s)
          dropdown itself is enough of a "not scoped to one shop" signal,
          and picking any shop already clears loadAllShops (below). */}
      <div className="relative z-40 flex items-end gap-2 flex-wrap">
        <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} customEnd={customEnd}
          onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} earliestDate={earliestDate} />
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
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
          <MultiSelectDropdown options={shopOptions} selected={shopLabels}
            onChange={setShopLabels}
            placeholder="All Shops" countNoun="shops" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Package(s)</span>
          <MultiSelectDropdown options={packageOptions} selected={packageFilters} onChange={setPackageFilters} placeholder="All Packages" countNoun="packages" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Product ID</span>
          <MultiSelectDropdown options={productIdOptions} selected={productIdFilters} onChange={setProductIdFilters} placeholder="All Products" countNoun="products" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide" title="Narrows the summary and the order detail by the order's first vehicle's make">Vehicle Make</span>
          <MultiSelectDropdown options={makeOptions} selected={vehicleMakes} onChange={setVehicleMakes} placeholder="All Makes" countNoun="makes" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide" title="Filters order detail — the models come from the loaded orders">Vehicle Model</span>
          <MultiSelectDropdown options={vehicleModelOptions} selected={vehicleModels} onChange={setVehicleModels} placeholder={vehicles.length ? 'All Models' : 'Load detail…'} countNoun="models" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide" title="Filters order detail — the years come from the loaded orders">Vehicle Year</span>
          <MultiSelectDropdown options={vehicleYearOptions} selected={vehicleYears} onChange={setVehicleYears} placeholder={vehicles.length ? 'All Years' : 'Load detail…'} countNoun="years" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Fleet</span>
          <MultiSelectDropdown options={fleetOptions} selected={fleetFilters} onChange={setFleetFilters} placeholder="All (Retail + Fleet)" countNoun="fleets" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Oil Only</span>
          <span className="flex items-center gap-1.5 h-[30px]" title="Only orders with at least one oil product (quart-uom) sold">
            <Toggle checked={oilOnly} onChange={setOilOnly} size="sm" color="cyan" />
            <span className="text-xs font-mono text-inky">{oilOnly ? 'On' : 'Off'}</span>
          </span>
        </div>
        <label className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Search</span>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order #, customer name, city…" />
        </label>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {(
        <>
          {/* Summary status — loads by itself; cancel it, and a filter change mid-load pauses until Apply. */}
          <div className="flex items-center gap-3 flex-wrap rounded-lg border border-navy/15 bg-cream px-3 py-1.5 text-[11px] font-mono text-inky">
            {rollups.status === 'loading' && <><SbLoader size={14} /><span>Loading summary…</span><Button size="sm" variant="ghost" onClick={rollups.cancel}>Cancel load</Button></>}
            {rollups.status === 'paused' && <><span className="text-sb-orange font-semibold">Filters changed while loading — the load was paused.</span><Button size="sm" onClick={rollups.apply}>Apply filters</Button></>}
            {rollups.status === 'cancelled' && <><span>Load cancelled.</span><Button size="sm" onClick={rollups.apply}>Load summary</Button></>}
            {rollups.status === 'error' && <><span className="text-sb-red">{rollups.error}</span><Button size="sm" onClick={rollups.apply}>Retry</Button></>}
            {rollups.status === 'idle' && (
              <>
                <span>{rollups.cachedAt ? `Showing the summary saved ${formatDistanceToNowStrict(rollups.cachedAt)} ago.` : summaryStats ? 'Summary is up to date for these filters.' : ''}</span>
                {rollups.cachedAt && <Button size="sm" variant="ghost" onClick={rollups.apply}>Refresh</Button>}
              </>
            )}
            {rollups.shopStatsLoading && <span className="flex items-center gap-1.5"><SbLoader size={12} />per-shop M5% / quarts loading…</span>}
          </div>

          {useSummaryStats && summaryLoading && !summaryStats ? (
            <LoadingProgress fraction={null} countText="Loading summary…" messages={['Reading the daily rollups…', 'Tallying packages by shop…']} />
          ) : !summaryStats && useSummaryStats ? null : (
            <>
              <div className="flex gap-3 flex-wrap">
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Orders</p>
                  <p className="text-lg font-heading font-bold text-navy">{effectiveTotals.count.toLocaleString()}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Revenue</p>
                  <p className="text-lg font-heading font-bold text-navy">{money(effectiveTotals.revenue)}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Avg Order Value</p>
                  <p className="text-lg font-heading font-bold text-navy">{money(effectiveTotals.avgOrderValue)}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Distinct Packages</p>
                  <p className="text-lg font-heading font-bold text-navy">{packageRows.length}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Avg Quarts (Oil Change)</p>
                  <p className="text-lg font-heading font-bold text-navy">{effectiveTotals.avgQuartsPerOilOrder > 0 ? effectiveTotals.avgQuartsPerOilOrder.toFixed(2) : '—'}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide" title="Air Filter, Cabin Air Filter, Wiper Blade Replacement, Additives, Tire Rotation — as a % of Oil Change packages. Classify packages on Package Mapping.">M5%</p>
                  <p className="text-lg font-heading font-bold text-navy">{effectiveTotals.m5Pct != null ? `${effectiveTotals.m5Pct.toFixed(1)}%` : '—'}</p>
                </CardBody></Card>
              </div>

              {/* Package + Shop summaries, side by side (the standard data grid: sort, filter, resize, export). */}
              <div className="grid gap-3 xl:grid-cols-2 items-start">
                <Card>
                  <CardBody className="flex flex-col gap-2">
                    <span className="text-xs font-mono text-navy uppercase tracking-wide">By Package ({packageRows.length})</span>
                    {packageRows.length === 0 ? (
                      <p className="text-xs font-mono text-inky/60">No packages in this filtered set.</p>
                    ) : (
                      <DataTable table={pkgTable} globalFilter={pkgFilter} onGlobalFilterChange={setPkgFilter} exportFilename={`Droptop packages - ${range.start} to ${range.end}`} bodyMaxHeightClass="max-h-[460px]" density="compact" />
                    )}
                  </CardBody>
                </Card>
                <Card>
                  <CardBody className="flex flex-col gap-2">
                    <span className="text-xs font-mono text-navy uppercase tracking-wide">By Shop ({shopRows.length})</span>
                    {shopRows.length === 0 ? (
                      <p className="text-xs font-mono text-inky/60">No shops in this filtered set.</p>
                    ) : (
                      <DataTable table={shopTable} globalFilter={shopFilter} onGlobalFilterChange={setShopFilter} exportFilename={`Droptop shops - ${range.start} to ${range.end}`} bodyMaxHeightClass="max-h-[460px]" density="compact"
                        onRowClick={(r) => { setReportShops(r.locationId === '—' ? [] : [r.shopLabel]); setReportRegions([]); setReportMarkets([]); setReportAMs([]); setReportMode('detail'); setReportPage(0); setReportOpen(true) }} />
                    )}
                  </CardBody>
                </Card>
              </div>
            </>
          )}

          {/* Order-level detail — deferred until explicitly requested: the
              raw per-order+package+product+service+vehicle fetch this backs
              (paginated orders table, ad-hoc filters, Build Your Own Report,
              exports) is the slow part for a large range; the stats above
              never need it. */}
          {!detailRequested ? (
            <div className="flex items-center gap-3 flex-wrap rounded-lg border border-navy/20 bg-cream px-3 py-2">
              <Button size="sm" variant="secondary" onClick={() => setDetailRequested(true)}>Load order detail</Button>
              <span className="text-[11px] font-mono text-inky/70">Individual orders, the Package/Product/Model/Year/Fleet filters and Build Your Own Report{shopIds.length ? '' : ' (all shops — slower for a big range)'}.</span>
            </div>
          ) : loading ? (
            <div className="flex flex-col gap-2">
            <div><Button size="sm" variant="ghost" onClick={() => setDetailRequested(false)}>Abort load</Button></div>
            <LoadingProgress
              fraction={loadProgress.total ? loadProgress.loaded / loadProgress.total : null}
              countText={
                loadProgress.total
                  ? `Loading orders — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
                  : loadProgress.loaded > 0
                    ? `Loading orders — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                    : 'Loading orders…'
              }
              messages={[
                'Pulling orders with packages, products, and vehicles…',
                'Matching packages to services…',
                'Tallying up totals…',
                'Sorting by date…',
              ]}
            />
            </div>
          ) : (
            /* Orders table — converted onto the standard DataTable stack
               (direct ask 2026-09-30, same design as the Orders v2 beta
               table): built-in search/sort/export plus a Manage Columns
               modal for show/hide/reorder/pin. DataTable's own pagination
               still only renders one page's worth of rows at a time, same
               as the old manual Prev/Next did. */
            <>
              <DataTable
                table={ordersTable}
                globalFilter={ordersFilter}
                onGlobalFilterChange={setOrdersFilter}
                exportFilename={`Droptop Orders - ${range.start} to ${range.end}`}
                hideColumnControl
                onRowClick={(o) => setViewingOrder(o)}
                actions={
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setReportOpen(true)}>Build Report</Button>
                    <button onClick={() => setOrdersColumnManagerOpen(true)}
                      className="text-xs font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">
                      Manage Columns
                    </button>
                  </>
                }
              />
              <ColumnManagerModal
                open={ordersColumnManagerOpen}
                onClose={() => setOrdersColumnManagerOpen(false)}
                all={ordersAllColItems}
                shown={ordersShownOrder}
                onChange={applyOrdersShownColumns}
                onReset={resetOrdersColumns}
                pinned={ordersColPinning.left ?? []}
                onPinChange={(left) => setOrdersColPinning({ left, right: [] })}
              />
            </>
          )}
        </>
      )}

      <Modal open={!!viewingOrder} onClose={() => setViewingOrder(null)}
        title={viewingOrder ? `Order ${viewingOrder.order_id}` : 'Order'} size="xl">
        {viewingOrder && (() => {
          // Direct ask 2026-10-02: Order #/Shop/Region/Customer/City/Status
          // (the "who/where" identity fields) keep the original stacked
          // label-over-value grid; Packages keeps that same stacked style
          // too (its value can wrap across lines, which doesn't suit a
          // single right-aligned row) — everything else becomes a flat
          // label-left/value-right list, one consistent indent, instead of
          // the old 2-per-row grid pairing.
          const topCols = DETAIL_COLUMNS.slice(0, 6)
          const packagesCol = DETAIL_COLUMNS.find((c) => c.key === 'packages')!
          const restCols = DETAIL_COLUMNS.filter((c) => c.key !== 'packages').slice(6)
          return (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                {topCols.map((c) => (
                  <div key={c.key} className="flex flex-col gap-0.5 min-w-0 border border-navy/20 rounded px-2.5 py-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-inky/80">{c.label}</span>
                    <span className="text-sm font-mono text-navy break-words">{c.get(viewingOrder)}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-0.5 min-w-0 border border-navy/20 rounded px-2.5 py-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/80">{packagesCol.label}</span>
                <span className="text-sm font-mono text-navy break-words">{packagesCol.get(viewingOrder)}</span>
              </div>
              <div className="flex flex-col border border-navy/20 rounded divide-y divide-navy/15">
                {restCols.map((c) => (
                  <div key={c.key} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                    <span className="text-[10px] font-mono uppercase tracking-widest text-inky/80 flex-shrink-0">{c.label}</span>
                    <span className="text-sm font-mono text-navy text-right">{c.get(viewingOrder)}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}
      </Modal>

      <Modal open={reportOpen} onClose={() => setReportOpen(false)}
        title={reportMode === 'detail' && reportShops.length === 1 ? `${reportShops[0]} — Orders` : 'Build Your Own Report'} size="2xl">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            Built from what&apos;s already loaded above ({range.start} to {range.end}) — the pickers below narrow that
            further, they don&apos;t pull in shops or dates outside it. Widen the Shop(s)/date range above first if
            something you need isn&apos;t showing up as an option here.
          </p>

          {singleReportShopId && !singleReportShopHasData && (
            <div className="flex items-center justify-between gap-2 flex-wrap rounded border border-sky/40 bg-sky/10 px-3 py-2">
              <p className="text-[11px] font-mono text-navy">
                Order-level detail for this range hasn&apos;t been loaded for {reportShops[0]} yet.
              </p>
              <Button size="sm" variant="secondary" loading={shopQuickLoading === singleReportShopId}
                onClick={() => void loadShopQuickly(singleReportShopId)}>
                Load Data for This Shop
              </Button>
            </div>
          )}

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
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="secondary" onClick={() => void copyReport()}>Copy</Button>
              <Button size="sm" variant="secondary" loading={reportExporting === 'csv'} onClick={() => exportReport('csv')}>Export CSV</Button>
              <Button size="sm" variant="secondary" loading={reportExporting === 'xlsx'} onClick={() => exportReport('xlsx')}>Export Excel</Button>
              {(reportMode === 'detail' ? reportOrders.length : reportTotalsRows.length) > REPORT_PAGE_SIZE && (
                <div className="flex items-center gap-2 text-[10px] font-mono text-inky/70">
                  <Button size="sm" variant="secondary" disabled={reportPage === 0} onClick={() => setReportPage((p) => Math.max(0, p - 1))}>Prev</Button>
                  <span>Page {reportPage + 1} of {reportPageCount}</span>
                  <Button size="sm" variant="secondary" disabled={reportPage >= reportPageCount - 1} onClick={() => setReportPage((p) => Math.min(reportPageCount - 1, p + 1))}>Next</Button>
                </div>
              )}
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
                  ? pagedReportOrders.map((o) => (
                    <tr key={o.id} className="border-b border-navy/10">
                      {activeDetailCols.map((c) => (
                        <td key={c.key} className={`px-3 py-1.5 text-navy whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>{c.get(o)}</td>
                      ))}
                    </tr>
                  ))
                  : pagedReportTotalsRows.map((r) => (
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
