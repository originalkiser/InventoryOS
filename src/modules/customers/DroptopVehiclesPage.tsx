// Droptop Vehicles — what's actually being serviced, rolled up by vehicle
// (year/make/model) rather than by order. Complements Droptop Orders (what
// got sold) and Customer Heatmap (where customers came from) with a third
// lens: what's driving through the bay.
//
// Trim and Engine are NOT in Droptop's own data — checked against real
// synced payloads and against Droptop's own API spec: the `vehicles` array
// only ever carries vin/license_plate/mileage/vin_vehicle_year/_make/_model
// (plus nullable other_vehicle_* for a non-VIN entry like a trailer).
// Filled in separately via the vin-decode Edge Function (NHTSA's free vPIC
// API), cached in inventory.vin_decoded — see the "Decode Engine/Trim"
// button below and vinDecodeService.ts.
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
import { Button, Card, CardBody, Modal, MultiSelectDropdown, Toggle } from '@/components/ui'
import { fetchDateRangeConcurrent } from '@/lib/concurrentDateRangeFetch'
import { runVinDecode } from '@/services/vinDecodeService'

interface OrderHeaderRow {
  id: string
  location_id: string | null
  order_finalized_at: string | null
  final_price: number | null
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
// Order header + its vehicles embedded via PostgREST's foreign-table select
// (droptop_order_vehicles.order_id references droptop_orders(id)) — one
// query per page instead of a header pull followed by a separate
// per-order-id vehicle pull. Embedding doesn't change the pagination math:
// a page is still exactly PAGE header rows regardless of how many vehicles
// ride along on each. See DroptopOrdersPage.tsx's own ORDER_EMBED_SELECT
// for the same pattern with more child tables.
interface OrderRowEmbedded extends OrderHeaderRow {
  droptop_order_vehicles: Omit<VehicleRow, 'order_id'>[]
}
const ORDER_EMBED_SELECT = `
  id, location_id, order_finalized_at, final_price,
  droptop_order_vehicles(vin, license_plate, vehicle_name, vin_vehicle_make, vin_vehicle_model, vin_vehicle_year, mileage)
`

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

// Vehicle identity — VIN when present (droptop_order_vehicles' own vin
// column is nullable, e.g. Droptop's "other_vehicle" trailer case), falling
// back to plate+name. Kept separate from the display label so two
// different vehicles that happen to share a label don't get merged.
function vehicleKeyOf(v: VehicleRow): string {
  return v.vin || `${v.license_plate ?? ''}|${v.vehicle_name ?? ''}`
}
// Standard VIN shape — matches the vin-decode Edge Function's own check.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

// Per-DISTINCT-VEHICLE intermediate — never rendered directly (a real
// company-month can have 100k+ distinct VINs, which is what crashed the
// page when this was the table). Rolled up further into MakeModelAgg below
// before anything reaches the DOM.
interface VehicleAgg {
  key: string
  vin: string | null // separate from `key` — key falls back to plate|name when vin is null
  shopLabel: string | null // set only in by-shop grouping
  year: number | null
  make: string | null
  model: string | null
  mileage: number | null // highest mileage reading seen, as a proxy for most-recent
  visits: number
  totalTicket: number
}
// One real vehicle's contribution to a single model-year, inside a
// MakeModelAgg's year breakdown. trims/engines collect every DISTINCT
// value seen for that year (a model-year can span more than one trim or
// engine option) rather than forcing a single value.
interface YearBreakdown { year: number | null; vehicleCount: number; totalMileage: number; mileageCount: number; trims: Set<string>; engines: Set<string> }
// What's actually rendered — one row per (make, model[, shop]), averaging
// mileage/ticket across every distinct vehicle of that make/model rather
// than listing vehicles individually. Bounded by how many real make/model
// combinations exist (dozens to a few hundred), not by vehicle count.
interface MakeModelAgg {
  key: string
  shopLabel: string | null
  make: string | null
  model: string | null
  vehicleCount: number
  visits: number
  totalTicket: number
  totalMileage: number
  mileageCount: number // vehicles that actually had a mileage reading (denominator for the average — not all do)
  trims: Set<string>
  engines: Set<string>
  byYear: Map<number | string, YearBreakdown>
}
// One VIN's decoded Trim/Engine, from inventory.vin_decoded.
interface VinDecoded { trim: string | null; engine: string | null }

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function DroptopVehiclesPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — franchise shops included by default here, matching
  // Droptop Orders/Customer Heatmap's own explicit 2026-09-01 decision.
  const loc = useLocations('other')
  const earliestDate = useEarliestOrderDate(companyId)
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod('droptop-vehicles:period', 'last_week')

  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [loadAllShops, setLoadAllShops] = useState(false)
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [filterYears, setFilterYears] = useState<string[]>([])
  const [filterMakes, setFilterMakes] = useState<string[]>([])
  const [filterModels, setFilterModels] = useState<string[]>([])
  // 'company' groups purely by vehicle (a vehicle serviced at 2 shops is one
  // row); 'by-shop' adds shop as part of the grouping key, same naming
  // convention as the Heatmap's own zip-export company/by-shop toggle.
  const [groupMode, setGroupMode] = useState<'company' | 'by-shop'>('company')

  const [orders, setOrders] = useState<OrderHeaderRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)
  // Trim/Engine, keyed by VIN — populated two ways: (1) a cheap read-only
  // query below, whenever the vehicles in view change, picks up whatever's
  // already cached in inventory.vin_decoded; (2) the "Decode Engine/Trim"
  // button below fills in the rest via the vin-decode Edge Function. Never
  // reset on filter changes — once a VIN is decoded there's no reason to
  // forget it just because the Year/Make/Model filters moved.
  const [vinDecodeMap, setVinDecodeMap] = useState<Map<string, VinDecoded>>(new Map())
  const [decoding, setDecoding] = useState(false)
  const [decodeProgress, setDecodeProgress] = useState<{ processed: number; total: number } | null>(null)

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const idToLabel = useMemo(() => new Map(loc.includedOptions.map((o) => [o.value, o.label])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

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
    if (!shopIds.length && !loadAllShops) {
      setOrders([]); setVehicles([])
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
      const { count } = await applyFilters(sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true }))
      if (!cancelled) setLoadProgress({ loaded: 0, total: count ?? null })

      // Kept more conservative than a flat header fetch (Max Rows is now
      // 10,000) since this query embeds droptop_order_vehicles per order —
      // see ORDER_EMBED_SELECT above.
      const PAGE = 2000
      const MAX_PAGE_RETRIES = 2
      let loadedSoFarLocal = 0
      const embedded = await fetchDateRangeConcurrent<OrderRowEmbedded>({
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
              .select(ORDER_EMBED_SELECT))
              .gte('order_finalized_at', subStartIso).lte('order_finalized_at', subEndIso)
              .order('order_finalized_at', { ascending: true })
              .order('id', { ascending: true }).limit(PAGE)
            if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
            const { data: pageData, error: err } = await q
            if (!err) return (pageData ?? []) as OrderRowEmbedded[]
            lastErr = err.message
            if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          }
          throw new Error(`${lastErr ?? 'Failed to load orders'} — loaded ${loadedSoFarLocal.toLocaleString()} order(s) before this happened`)
        },
      })
      if (cancelled) return

      const allOrders: OrderHeaderRow[] = []
      const vehRows: VehicleRow[] = []
      for (const o of embedded) {
        const { droptop_order_vehicles, ...header } = o
        allOrders.push(header)
        for (const v of droptop_order_vehicles ?? []) vehRows.push({ order_id: o.id, ...v })
      }

      setOrders(allOrders)
      setVehicles(vehRows)
      setLoading(false)
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, range.start, range.end, shopIds.join(','), loadAllShops]) // eslint-disable-line react-hooks/exhaustive-deps

  const ordersById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders])
  const filteredOrderIds = useMemo(() => {
    const s = new Set<string>()
    for (const o of orders) {
      if (allowedLocationIds !== null && (!o.location_id || !allowedLocationIds.has(o.location_id))) continue
      s.add(o.id)
    }
    return s
  }, [orders, allowedLocationIds])

  // Year/Make/Model option lists — each narrowed progressively by the
  // filters above it, same cascading pattern as Region -> Market -> AM.
  const vehiclesInScope = useMemo(() => vehicles.filter((v) => filteredOrderIds.has(v.order_id)), [vehicles, filteredOrderIds])
  const yearOptions = useMemo(
    () => [...new Set(vehiclesInScope.map((v) => v.vin_vehicle_year).filter((y): y is number => y != null))].sort((a, b) => b - a).map((y) => ({ value: String(y) })),
    [vehiclesInScope],
  )
  const makeOptions = useMemo(() => {
    let vs = vehiclesInScope
    if (filterYears.length) vs = vs.filter((v) => v.vin_vehicle_year != null && filterYears.includes(String(v.vin_vehicle_year)))
    return [...new Set(vs.map((v) => v.vin_vehicle_make).filter((m): m is string => !!m))].sort().map((v) => ({ value: v }))
  }, [vehiclesInScope, filterYears])
  const modelOptions = useMemo(() => {
    let vs = vehiclesInScope
    if (filterYears.length) vs = vs.filter((v) => v.vin_vehicle_year != null && filterYears.includes(String(v.vin_vehicle_year)))
    if (filterMakes.length) vs = vs.filter((v) => v.vin_vehicle_make != null && filterMakes.includes(v.vin_vehicle_make))
    return [...new Set(vs.map((v) => v.vin_vehicle_model).filter((m): m is string => !!m))].sort().map((v) => ({ value: v }))
  }, [vehiclesInScope, filterYears, filterMakes])

  // Pass 1 — per distinct vehicle (can be 100k+ rows for a big company;
  // never rendered, just folded into makeModelAggs below).
  const vehicleAggs = useMemo((): VehicleAgg[] => {
    const byKey = new Map<string, VehicleAgg>()
    for (const v of vehiclesInScope) {
      if (filterYears.length && !(v.vin_vehicle_year != null && filterYears.includes(String(v.vin_vehicle_year)))) continue
      if (filterMakes.length && !(v.vin_vehicle_make && filterMakes.includes(v.vin_vehicle_make))) continue
      if (filterModels.length && !(v.vin_vehicle_model && filterModels.includes(v.vin_vehicle_model))) continue
      const order = ordersById.get(v.order_id)
      if (!order) continue
      const shopLabel = groupMode === 'by-shop' ? (order.location_id ? (idToLabel.get(order.location_id) ?? order.location_id) : '—') : null
      const key = `${vehicleKeyOf(v)}|${shopLabel ?? ''}`
      let a = byKey.get(key)
      if (!a) {
        a = { key, vin: v.vin, shopLabel, year: v.vin_vehicle_year, make: v.vin_vehicle_make, model: v.vin_vehicle_model, mileage: v.mileage, visits: 0, totalTicket: 0 }
        byKey.set(key, a)
      }
      a.visits++
      a.totalTicket += order.final_price ?? 0
      if (v.mileage != null && (a.mileage == null || v.mileage > a.mileage)) a.mileage = v.mileage
    }
    return [...byKey.values()]
  }, [vehiclesInScope, ordersById, filterYears, filterMakes, filterModels, groupMode, idToLabel])

  // Distinct, structurally-valid VINs currently in view — the universe the
  // "Decode Engine/Trim" button and its auto-cache-check below operate on.
  // Non-VIN identities (the license_plate|vehicle_name fallback) can't be
  // decoded at all and are silently excluded.
  const vinsInScope = useMemo(
    () => [...new Set(vehicleAggs.map((v) => v.vin).filter((v): v is string => !!v && VIN_RE.test(v)))],
    [vehicleAggs],
  )
  // Read-only cache check — no Edge Function call, just picks up whatever
  // Trim/Engine is already cached (decoded by anyone, any time) for VINs
  // now in view. Chunked like the other by-id lookups in this app, in case
  // a big filtered view has thousands of distinct VINs.
  useEffect(() => {
    const missing = vinsInScope.filter((v) => !vinDecodeMap.has(v))
    if (!missing.length) return
    let cancelled = false
    const sb = supabase as any
    const CHUNK = 500
    async function run() {
      const found = new Map<string, VinDecoded>()
      for (let i = 0; i < missing.length; i += CHUNK) {
        if (cancelled) return
        const { data, error } = await sb.schema('inventory').from('vin_decoded').select('vin, trim, engine').in('vin', missing.slice(i, i + CHUNK))
        if (error) continue
        for (const r of (data ?? []) as { vin: string; trim: string | null; engine: string | null }[]) found.set(r.vin, { trim: r.trim, engine: r.engine })
      }
      if (!cancelled && found.size) setVinDecodeMap((prev) => new Map([...prev, ...found]))
    }
    run()
    return () => { cancelled = true }
  }, [vinsInScope, vinDecodeMap])

  async function decodeMissingVins() {
    const missing = vinsInScope.filter((v) => !vinDecodeMap.has(v))
    if (!missing.length) { toast.success('Everything in view is already decoded'); return }
    setDecoding(true)
    setDecodeProgress({ processed: 0, total: missing.length })
    try {
      const summary = await runVinDecode(missing, setDecodeProgress)
      // Re-read the cache for exactly the VINs just requested — covers
      // decoded AND not_found/error outcomes (the Edge Function upserts a
      // row either way), so a bad VIN doesn't get retried forever by the
      // auto-cache-check effect above.
      const sb = supabase as any
      const found = new Map<string, VinDecoded>()
      const CHUNK = 500
      for (let i = 0; i < missing.length; i += CHUNK) {
        const { data } = await sb.schema('inventory').from('vin_decoded').select('vin, trim, engine').in('vin', missing.slice(i, i + CHUNK))
        for (const r of (data ?? []) as { vin: string; trim: string | null; engine: string | null }[]) found.set(r.vin, { trim: r.trim, engine: r.engine })
      }
      // A VIN still missing here means its row genuinely never got
      // written (a hard failure already surfaced via the toast below) —
      // mark it empty so it isn't retried on every render either.
      for (const vin of missing) if (!found.has(vin)) found.set(vin, { trim: null, engine: null })
      setVinDecodeMap((prev) => new Map([...prev, ...found]))
      if (summary.warnings.length) toast.error(`Decoded with ${summary.warnings.length} warning(s) — see console`)
      else toast.success(`Decoded ${summary.newlyDecoded} of ${summary.requested} vehicle(s)`)
      if (summary.warnings.length) console.warn('[VIN-DECODE]', summary.warnings)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Decode failed')
    } finally {
      setDecoding(false)
      setDecodeProgress(null)
    }
  }

  // Pass 2 — roll distinct vehicles up to (make, model[, shop]), the only
  // thing actually rendered. Bounded by real make/model combinations, not
  // by vehicle count, which is what makes this safe to put on screen.
  const makeModelAggs = useMemo((): MakeModelAgg[] => {
    const byKey = new Map<string, MakeModelAgg>()
    for (const v of vehicleAggs) {
      const key = `${v.shopLabel ?? ''}|${v.make ?? '—'}|${v.model ?? '—'}`
      let a = byKey.get(key)
      if (!a) {
        a = { key, shopLabel: v.shopLabel, make: v.make, model: v.model, vehicleCount: 0, visits: 0, totalTicket: 0, totalMileage: 0, mileageCount: 0, trims: new Set(), engines: new Set(), byYear: new Map() }
        byKey.set(key, a)
      }
      a.vehicleCount++
      a.visits += v.visits
      a.totalTicket += v.totalTicket
      if (v.mileage != null) { a.totalMileage += v.mileage; a.mileageCount++ }
      const decoded = v.vin ? vinDecodeMap.get(v.vin) : undefined
      if (decoded?.trim) a.trims.add(decoded.trim)
      if (decoded?.engine) a.engines.add(decoded.engine)

      const yearKey = v.year ?? 'Unknown'
      let y = a.byYear.get(yearKey)
      if (!y) { y = { year: v.year, vehicleCount: 0, totalMileage: 0, mileageCount: 0, trims: new Set(), engines: new Set() }; a.byYear.set(yearKey, y) }
      y.vehicleCount++
      if (v.mileage != null) { y.totalMileage += v.mileage; y.mileageCount++ }
      if (decoded?.trim) y.trims.add(decoded.trim)
      if (decoded?.engine) y.engines.add(decoded.engine)
    }
    return [...byKey.values()].sort((a, b) => b.visits - a.visits)
  }, [vehicleAggs, vinDecodeMap])

  const PAGE_SIZE = 100
  const [page, setPage] = useState(0)
  useEffect(() => { setPage(0) }, [filterYears, filterMakes, filterModels, groupMode, shopIds.join(','), filterRegions, filterMarkets, filterAMs])
  const totalPages = Math.max(1, Math.ceil(makeModelAggs.length / PAGE_SIZE))
  const pagedRows = useMemo(() => makeModelAggs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [makeModelAggs, page])

  const [drilldown, setDrilldown] = useState<MakeModelAgg | null>(null)
  const pendingDecodeCount = useMemo(() => vinsInScope.filter((v) => !vinDecodeMap.has(v)).length, [vinsInScope, vinDecodeMap])

  function exportRows(format: 'csv' | 'xlsx') {
    if (!makeModelAggs.length) { toast.error('Nothing to export for this selection'); return }
    setExporting(format)
    try {
      const headers = groupMode === 'by-shop'
        ? ['Shop', 'Make', 'Model', 'Trim(s)', 'Engine(s)', 'Avg Mileage', 'Visits', 'Avg Ticket']
        : ['Make', 'Model', 'Trim(s)', 'Engine(s)', 'Avg Mileage', 'Visits', 'Avg Ticket']
      const rows = makeModelAggs.map((a) => {
        const avgMileage = a.mileageCount > 0 ? Math.round(a.totalMileage / a.mileageCount) : null
        const base = [a.make ?? '—', a.model ?? '—', [...a.trims].sort().join('; ') || '—', [...a.engines].sort().join('; ') || '—', avgMileage != null ? String(avgMileage) : '—', String(a.visits), (a.totalTicket / a.visits).toFixed(2)]
        return groupMode === 'by-shop' ? [a.shopLabel ?? '—', ...base] : base
      })
      const fileBase = `droptop-vehicles-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
        XLSX.utils.book_append_sheet(wb, ws, 'Vehicles')
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
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Droptop Vehicles</h1>
        <p className="text-xs text-inky mt-0.5">
          What's actually being serviced, by vehicle — year/make/model, visit frequency, average ticket. Trim and
          Engine aren't available from Droptop (VIN decode only gives year/make/model).
        </p>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
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
            onChange={(labels) => { setShopLabels(labels); if (labels.length) setLoadAllShops(false) }}
            placeholder="All Shops" countNoun="shops" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Year</span>
          <MultiSelectDropdown options={yearOptions} selected={filterYears} onChange={setFilterYears} placeholder="All Years" countNoun="years" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Make</span>
          <MultiSelectDropdown options={makeOptions} selected={filterMakes} onChange={setFilterMakes} placeholder="All Makes" countNoun="makes" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Model</span>
          <MultiSelectDropdown options={modelOptions} selected={filterModels} onChange={setFilterModels} placeholder="All Models" countNoun="models" searchable />
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Detail</span>
          <span className="flex items-center gap-1.5 h-[30px]" title="Company groups a vehicle across every shop it visited; By Shop breaks the same vehicle out per shop">
            <Toggle checked={groupMode === 'by-shop'} onChange={(v) => setGroupMode(v ? 'by-shop' : 'company')} size="sm" color="cyan" />
            <span className="text-xs font-mono text-inky">{groupMode === 'by-shop' ? 'By Shop' : 'Company'}</span>
          </span>
        </label>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {!shopIds.length && !loadAllShops ? (
        <Card><CardBody className="flex flex-col gap-2">
          <p className="text-xs font-mono text-inky/60">
            Select at least one shop above to load vehicles — an unscoped pull across every shop for a date range is
            slow and disabled by default.
          </p>
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setLoadAllShops(true)}>
            Load All Shops for This Period
          </Button>
        </CardBody></Card>
      ) : loading ? (
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
            'Pulling orders with vehicles attached…',
            'Matching vehicles to orders…',
            'Rolling up by year/make/model…',
            'Sorting by visits…',
          ]}
        />
      ) : (
        <>
          <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Distinct Vehicles</p>
              <p className="text-lg font-heading font-bold text-navy">{vehicleAggs.length.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Make/Model Combos</p>
              <p className="text-lg font-heading font-bold text-navy">{makeModelAggs.length.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Visits</p>
              <p className="text-lg font-heading font-bold text-navy">{makeModelAggs.reduce((s, a) => s + a.visits, 0).toLocaleString()}</p>
            </CardBody></Card>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] font-mono text-inky/60">Click a row for its year-by-year breakdown.</p>
            <div className="flex items-center gap-2 flex-wrap">
              {decoding ? (
                <span className="text-[10px] font-mono text-inky/70">
                  Decoding… {decodeProgress ? `${decodeProgress.processed.toLocaleString()} of ${decodeProgress.total.toLocaleString()}` : ''}
                </span>
              ) : pendingDecodeCount > 0 ? (
                <Button size="sm" variant="secondary" onClick={decodeMissingVins}
                  title="Look up Trim/Engine for VINs in view via NHTSA's free VIN-decode API — decoded VINs are cached forever, never re-decoded">
                  Decode Engine/Trim ({pendingDecodeCount.toLocaleString()})
                </Button>
              ) : vinsInScope.length > 0 && (
                <span className="text-[10px] font-mono text-inky/50">Engine/Trim decoded for all {vinsInScope.length.toLocaleString()} VIN(s) in view</span>
              )}
              <Button size="sm" variant="secondary" loading={exporting === 'csv'} onClick={() => exportRows('csv')}>Export CSV</Button>
              <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} onClick={() => exportRows('xlsx')}>Export XLSX</Button>
              {makeModelAggs.length > PAGE_SIZE && (
                <div className="flex items-center gap-2 text-[10px] font-mono text-inky/70">
                  <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
                  <span>Page {page + 1} of {totalPages}</span>
                  <Button size="sm" variant="secondary" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>Next</Button>
                </div>
              )}
            </div>
          </div>

          {makeModelAggs.length === 0 ? (
            <Card><CardBody>
              <p className="text-xs font-mono text-inky/60">No vehicle data for this selection — either no orders in range, or none of them have a matched vehicle yet.</p>
            </CardBody></Card>
          ) : (
            <div className="overflow-x-auto rounded border border-navy/30 max-h-[32rem] overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-cream">
                  <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                    {groupMode === 'by-shop' && <th className="px-3 py-2 text-left">Shop</th>}
                    <th className="px-3 py-2 text-left">Make</th>
                    <th className="px-3 py-2 text-left">Model</th>
                    <th className="px-3 py-2 text-left">Trim(s)</th>
                    <th className="px-3 py-2 text-left">Engine(s)</th>
                    <th className="px-3 py-2 text-right">Avg Mileage</th>
                    <th className="px-3 py-2 text-right">Visits</th>
                    <th className="px-3 py-2 text-right">Avg Ticket</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((a) => {
                    const avgMileage = a.mileageCount > 0 ? Math.round(a.totalMileage / a.mileageCount) : null
                    return (
                      <tr key={a.key} className="border-b border-navy/10 cursor-pointer hover:bg-sky/10 transition-colors" onClick={() => setDrilldown(a)}>
                        {groupMode === 'by-shop' && <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.shopLabel}</td>}
                        <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.make ?? '—'}</td>
                        <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.model ?? '—'}</td>
                        <td className="px-3 py-1.5 text-navy">{[...a.trims].sort().join(', ') || '—'}</td>
                        <td className="px-3 py-1.5 text-navy">{[...a.engines].sort().join(', ') || '—'}</td>
                        <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{avgMileage != null ? avgMileage.toLocaleString() : '—'}</td>
                        <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{a.visits.toLocaleString()}</td>
                        <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(a.totalTicket / a.visits)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Modal open={drilldown != null} onClose={() => setDrilldown(null)}
        title={drilldown ? `${drilldown.make ?? '—'} ${drilldown.model ?? '—'}${drilldown.shopLabel ? ` — ${drilldown.shopLabel}` : ''}` : ''}>
        {drilldown && (
          <div className="overflow-x-auto rounded border border-navy/30 max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-cream">
                <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Year</th>
                  <th className="px-3 py-2 text-left">Trim(s)</th>
                  <th className="px-3 py-2 text-left">Engine(s)</th>
                  <th className="px-3 py-2 text-right">Vehicles</th>
                  <th className="px-3 py-2 text-right">Avg Mileage</th>
                </tr>
              </thead>
              <tbody>
                {[...drilldown.byYear.values()]
                  .sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity))
                  .map((y) => (
                    <tr key={y.year ?? 'unknown'} className="border-b border-navy/10">
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{y.year ?? 'Unknown'}</td>
                      <td className="px-3 py-1.5 text-navy">{[...y.trims].sort().join(', ') || '—'}</td>
                      <td className="px-3 py-1.5 text-navy">{[...y.engines].sort().join(', ') || '—'}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{y.vehicleCount.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{y.mileageCount > 0 ? Math.round(y.totalMileage / y.mileageCount).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  )
}
