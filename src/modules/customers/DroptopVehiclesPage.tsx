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
// MakeModelAgg's year breakdown. trims/engines count ORDERS (not distinct
// vehicles) per distinct value seen for that year (a model-year can span
// more than one trim or engine option) — matches what the UI shows next to
// each value ("Sport (42)" = 42 orders across vehicles with that trim).
interface YearBreakdown { year: number | null; vehicleCount: number; totalMileage: number; mileageCount: number; trims: Map<string, number>; engines: Map<string, number> }
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
  trims: Map<string, number> // value -> visit count
  engines: Map<string, number>
  byYear: Map<number | string, YearBreakdown>
}
// One VIN's decoded Trim/Engine, from inventory.vin_decoded.
interface VinDecoded { trim: string | null; engine: string | null }

// Bounded-concurrency chunked read of inventory.vin_decoded for a list of
// VINs — used both by the main load (hydrates every loaded vehicle's
// Trim/Engine up front, as part of the same loading spinner, instead of a
// separate pass that runs after the table's already visible) and by the
// Decode button's own post-decode re-read. A plain sequential 500-at-a-time
// loop here used to be the real cause of "Trim(s)/Engine(s) show — for a
// long time after the page loads, and the Decode button's own count looks
// like almost nothing is cached even when most of it already is" — a wide
// date range's 100k+ VINs took well over a minute of purely sequential
// round trips to read back. Same worker-pool shape as droptopChildFetch.ts.
//
// Chunk size MUST stay small: this is a GET request, so `.in('vin', chunk)`
// gets serialized into the URL's query string — a chunk of 5000 17-char
// VINs (~100k characters) blows past Kong/nginx's request-line limit and
// gets rejected with no visible error (the failure was being swallowed by
// `if (!error)` below), silently dropping that whole chunk from the map.
// That's what caused the real bug reported 2026-09-03: the page's own "all
// decoded" banner was accurate (every VIN had *some* map entry) but most
// Engine/Trim values were missing, because a prior manual "Decode" run's
// post-decode re-read (see decodeMissingVins) hit this same failure and
// then explicitly cached the unread VINs as `{trim:null, engine:null}` —
// permanently masking real, already-decoded rows already sitting in the
// table. 300 matches this file's own edge-function CHUNK_SIZE (a request
// body, not a URL, but already proven safe) and droptopChildFetch.ts's
// ORDER_ID_CHUNK precedent (200 36-char UUIDs) for the same GET-`.in()`
// constraint. Concurrency can run higher than that file's since this is a
// light indexed read, not an outbound NHTSA call.
const VIN_DECODE_READ_CHUNK = 300
const VIN_DECODE_READ_CONCURRENCY = 8
// onChunk fires once per completed chunk (with that chunk's VIN count) so
// a caller can fold this into its own overall progress bar instead of the
// bar looking stuck at 100% while this runs silently underneath it.
// `hadErrors` on the return tells a caller that some chunk failed (e.g. a
// transient network error) — the map is a partial result, not "every VIN
// checked and genuinely not found," and callers should not treat any VIN
// missing from it as confirmed-undecoded when this is true.
async function fetchVinDecodeMap(
  vins: string[],
  onChunk?: (n: number) => void,
): Promise<{ map: Map<string, VinDecoded>; hadErrors: boolean }> {
  const found = new Map<string, VinDecoded>()
  if (!vins.length) return { map: found, hadErrors: false }
  const chunks: string[][] = []
  for (let i = 0; i < vins.length; i += VIN_DECODE_READ_CHUNK) chunks.push(vins.slice(i, i + VIN_DECODE_READ_CHUNK))
  const sb = supabase as any
  let next = 0
  let hadErrors = false
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= chunks.length) return
      const { data, error } = await sb.schema('inventory').from('vin_decoded').select('vin, trim, engine').in('vin', chunks[i])
      if (error) {
        hadErrors = true
        console.warn('[VIN-DECODE] read chunk failed', error)
      } else {
        for (const r of (data ?? []) as { vin: string; trim: string | null; engine: string | null }[]) found.set(r.vin, { trim: r.trim, engine: r.engine })
      }
      onChunk?.(chunks[i].length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(VIN_DECODE_READ_CONCURRENCY, chunks.length) }, worker))
  return { map: found, hadErrors }
}

// Shows the top N values by count ("Sport (42), Limited (18), SE (9)"),
// with a "+N more"/"show less" toggle for the rest — used for both Trim(s)
// and Engine(s), which can span many distinct values per make/model. Own
// local expand state (not lifted to the table) so each cell/row is
// independent; stopPropagation keeps the toggle from also triggering the
// row's own onClick (opening the year drill-down modal).
function TopValuesCell({ counts, topN = 3 }: { counts: Map<string, number>; topN?: number }) {
  const [expanded, setExpanded] = useState(false)
  const sorted = useMemo(
    () => [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [counts],
  )
  if (!sorted.length) return <>—</>
  const shown = expanded ? sorted : sorted.slice(0, topN)
  const remaining = sorted.length - topN
  return (
    <>
      {shown.map(([value, count]) => `${value} (${count})`).join(', ')}
      {remaining > 0 && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v) }}
          className="ml-1 text-sky hover:underline whitespace-nowrap">
          {expanded ? 'show less' : `+${remaining} more`}
        </button>
      )}
    </>
  )
}

// Every value, sorted by count desc — export isn't space-constrained the
// way the on-screen top-3 cell is, so this shows the full breakdown.
function formatCounts(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => `${v} (${n})`).join('; ')
}

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
  // Engine comes from vinDecodeMap (a decode result), not a raw
  // VehicleRow field like Year/Make/Model — so this filter and its option
  // list both need to look each vehicle's engine up by VIN rather than
  // reading it directly off the row.
  const [filterEngines, setFilterEngines] = useState<string[]>([])
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
  // Trim/Engine, keyed by VIN — populated two ways: (1) as part of the main
  // load below (every vehicle just loaded gets its cached Trim/Engine
  // pulled in the same pass, before the loading spinner clears — not a
  // separate slow catch-up the user has to wait out after the table
  // already looks done); (2) the "Decode Engine/Trim" button fills in
  // whatever's still missing via the vin-decode Edge Function. Untouched by
  // Year/Make/Model filter changes — those don't reload data, so whatever
  // this already has stays valid.
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

      // Hydrate every loaded vehicle's cached Trim/Engine as part of THIS
      // load — see fetchVinDecodeMap's own comment for why a separate
      // reactive pass was slow enough to be its own bug. Folded into the
      // SAME loadProgress bar (extend the denominator, then advance as
      // each chunk completes) rather than letting the bar sit at a
      // stuck-looking 100% while this runs silently underneath it — a real
      // report: this read can take ~20s on a wide range with 100k+ VINs
      // even at this helper's own faster chunk/concurrency settings.
      const distinctVins = [...new Set(vehRows.map((v) => v.vin).filter((v): v is string => !!v && VIN_RE.test(v)))]
      if (!cancelled) setLoadProgress((p) => ({ loaded: p.loaded, total: (p.total ?? 0) + distinctVins.length }))
      const { map: decodeMap, hadErrors: decodeReadHadErrors } = await fetchVinDecodeMap(distinctVins, (n) => {
        if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: p.loaded + n }))
      })
      if (cancelled) return
      if (decodeReadHadErrors) toast.error('Some cached Engine/Trim data failed to load — Trim(s)/Engine(s) may be incomplete for this view')

      setOrders(allOrders)
      setVehicles(vehRows)
      setVinDecodeMap(decodeMap)
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
  // Engine is a decode result (vinDecodeMap), not a raw field on the
  // vehicle row — look each candidate vehicle's VIN up rather than reading
  // an engine column directly. Only vehicles with a decoded engine
  // contribute an option; an undecoded VIN just doesn't show up here yet.
  const engineOptions = useMemo(() => {
    let vs = vehiclesInScope
    if (filterYears.length) vs = vs.filter((v) => v.vin_vehicle_year != null && filterYears.includes(String(v.vin_vehicle_year)))
    if (filterMakes.length) vs = vs.filter((v) => v.vin_vehicle_make != null && filterMakes.includes(v.vin_vehicle_make))
    if (filterModels.length) vs = vs.filter((v) => v.vin_vehicle_model != null && filterModels.includes(v.vin_vehicle_model))
    const engines = new Set<string>()
    for (const v of vs) {
      const decoded = v.vin ? vinDecodeMap.get(v.vin) : undefined
      if (decoded?.engine) engines.add(decoded.engine)
    }
    return [...engines].sort().map((v) => ({ value: v }))
  }, [vehiclesInScope, filterYears, filterMakes, filterModels, vinDecodeMap])

  // Pass 1 — per distinct vehicle (can be 100k+ rows for a big company;
  // never rendered, just folded into makeModelAggs below).
  const vehicleAggs = useMemo((): VehicleAgg[] => {
    const byKey = new Map<string, VehicleAgg>()
    for (const v of vehiclesInScope) {
      if (filterYears.length && !(v.vin_vehicle_year != null && filterYears.includes(String(v.vin_vehicle_year)))) continue
      if (filterMakes.length && !(v.vin_vehicle_make && filterMakes.includes(v.vin_vehicle_make))) continue
      if (filterModels.length && !(v.vin_vehicle_model && filterModels.includes(v.vin_vehicle_model))) continue
      if (filterEngines.length) {
        const decoded = v.vin ? vinDecodeMap.get(v.vin) : undefined
        if (!decoded?.engine || !filterEngines.includes(decoded.engine)) continue
      }
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
  }, [vehiclesInScope, ordersById, filterYears, filterMakes, filterModels, filterEngines, vinDecodeMap, groupMode, idToLabel])

  // Distinct, structurally-valid VINs currently in view — the universe the
  // "Decode Engine/Trim" button operates on. Non-VIN identities (the
  // license_plate|vehicle_name fallback) can't be decoded at all and are
  // silently excluded.
  const vinsInScope = useMemo(
    () => [...new Set(vehicleAggs.map((v) => v.vin).filter((v): v is string => !!v && VIN_RE.test(v)))],
    [vehicleAggs],
  )
  async function decodeMissingVins() {
    const missing = vinsInScope.filter((v) => !vinDecodeMap.has(v))
    if (!missing.length) { toast.success('Everything in view is already decoded'); return }
    setDecoding(true)
    setDecodeProgress({ processed: 0, total: missing.length })
    try {
      const summary = await runVinDecode(missing, setDecodeProgress)
      // Re-read the cache for exactly the VINs just requested — covers
      // decoded AND not_found/error outcomes (the Edge Function upserts a
      // row either way), so a bad VIN doesn't get retried forever the next
      // time this page loads.
      const { map: found, hadErrors: reReadHadErrors } = await fetchVinDecodeMap(missing)
      // A VIN still missing here means its row genuinely never got
      // written (a hard failure already surfaced via the toast below) —
      // mark it empty so it isn't retried on every render either. But only
      // when the re-read itself actually succeeded end-to-end: if any
      // chunk of it errored, "missing from `found`" no longer means
      // "confirmed not written" — it can just mean that chunk's request
      // failed — and poisoning those VINs to null would permanently hide
      // real Engine/Trim data the Edge Function just upserted (this is
      // exactly what caused the 2026-09-03 "decoded for all N VINs but
      // barely any Engine values show" bug).
      if (!reReadHadErrors) {
        for (const vin of missing) if (!found.has(vin)) found.set(vin, { trim: null, engine: null })
      } else {
        toast.error('Some decoded results failed to read back — reload the page to pick up anything missed')
      }
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
        a = { key, shopLabel: v.shopLabel, make: v.make, model: v.model, vehicleCount: 0, visits: 0, totalTicket: 0, totalMileage: 0, mileageCount: 0, trims: new Map(), engines: new Map(), byYear: new Map() }
        byKey.set(key, a)
      }
      a.vehicleCount++
      a.visits += v.visits
      a.totalTicket += v.totalTicket
      if (v.mileage != null) { a.totalMileage += v.mileage; a.mileageCount++ }
      const decoded = v.vin ? vinDecodeMap.get(v.vin) : undefined
      if (decoded?.trim) a.trims.set(decoded.trim, (a.trims.get(decoded.trim) ?? 0) + v.visits)
      if (decoded?.engine) a.engines.set(decoded.engine, (a.engines.get(decoded.engine) ?? 0) + v.visits)

      const yearKey = v.year ?? 'Unknown'
      let y = a.byYear.get(yearKey)
      if (!y) { y = { year: v.year, vehicleCount: 0, totalMileage: 0, mileageCount: 0, trims: new Map(), engines: new Map() }; a.byYear.set(yearKey, y) }
      y.vehicleCount++
      if (v.mileage != null) { y.totalMileage += v.mileage; y.mileageCount++ }
      if (decoded?.trim) y.trims.set(decoded.trim, (y.trims.get(decoded.trim) ?? 0) + v.visits)
      if (decoded?.engine) y.engines.set(decoded.engine, (y.engines.get(decoded.engine) ?? 0) + v.visits)
    }
    return [...byKey.values()].sort((a, b) => b.visits - a.visits)
  }, [vehicleAggs, vinDecodeMap])

  const PAGE_SIZE = 100
  const [page, setPage] = useState(0)
  useEffect(() => { setPage(0) }, [filterYears, filterMakes, filterModels, filterEngines, groupMode, shopIds.join(','), filterRegions, filterMarkets, filterAMs])
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
        const base = [a.make ?? '—', a.model ?? '—', formatCounts(a.trims) || '—', formatCounts(a.engines) || '—', avgMileage != null ? String(avgMileage) : '—', String(a.visits), (a.totalTicket / a.visits).toFixed(2)]
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
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Engine</span>
          <MultiSelectDropdown options={engineOptions} selected={filterEngines} onChange={setFilterEngines} placeholder="All Engines" countNoun="engines" searchable />
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
            'Loading cached Engine/Trim data…',
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
            <div className="overflow-x-auto rounded border border-navy/30 max-h-[64rem] overflow-y-auto">
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
                        <td className="px-3 py-1.5 text-navy">{<TopValuesCell counts={a.trims} />}</td>
                        <td className="px-3 py-1.5 text-navy">{<TopValuesCell counts={a.engines} />}</td>
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

      <Modal open={drilldown != null} onClose={() => setDrilldown(null)} size="2xl"
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
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{<TopValuesCell counts={y.trims} />}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{<TopValuesCell counts={y.engines} />}</td>
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
