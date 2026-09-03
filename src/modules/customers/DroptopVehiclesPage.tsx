// Droptop Vehicles — what's actually being serviced, rolled up by vehicle
// (year/make/model) rather than by order. Complements Droptop Orders (what
// got sold) and Customer Heatmap (where customers came from) with a third
// lens: what's driving through the bay.
//
// Trim and Engine are NOT available — checked against real synced payloads
// and against Droptop's own API spec: the `vehicles` array only ever
// carries vin/license_plate/mileage/vin_vehicle_year/_make/_model (plus
// nullable other_vehicle_* for a non-VIN entry like a trailer). Getting
// Trim/Engine would mean a separate VIN-decode integration (e.g. NHTSA's
// free vPIC API) against a new cache table — a real follow-up, not built
// here.
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
import { Button, Card, CardBody, MultiSelectDropdown, Toggle } from '@/components/ui'
import { fetchDateRangeConcurrent } from '@/lib/concurrentDateRangeFetch'
import { fetchByOrderIds } from '@/lib/droptopChildFetch'

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

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

// Vehicle identity — VIN when present (droptop_order_vehicles' own vin
// column is nullable, e.g. Droptop's "other_vehicle" trailer case), falling
// back to plate+name. Kept separate from the display label so two
// different vehicles that happen to share a label don't get merged.
function vehicleKeyOf(v: VehicleRow): string {
  return v.vin || `${v.license_plate ?? ''}|${v.vehicle_name ?? ''}`
}

interface VehicleAgg {
  key: string
  shopLabel: string | null // set only in by-shop grouping
  year: number | null
  make: string | null
  model: string | null
  mileage: number | null // highest mileage reading seen, as a proxy for most-recent
  visits: number
  totalTicket: number
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
  // 'company' groups purely by vehicle (a vehicle serviced at 2 shops is one
  // row); 'by-shop' adds shop as part of the grouping key, same naming
  // convention as the Heatmap's own zip-export company/by-shop toggle.
  const [groupMode, setGroupMode] = useState<'company' | 'by-shop'>('company')

  const [orders, setOrders] = useState<OrderHeaderRow[]>([])
  const [vehicles, setVehicles] = useState<VehicleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })
  const [detailProgress, setDetailProgress] = useState<{ loaded: number; total: number } | null>(null)
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)

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
      const { count } = await applyFilters(sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true }))
      if (!cancelled) setLoadProgress({ loaded: 0, total: count ?? null })

      const PAGE = 1000
      const MAX_PAGE_RETRIES = 2
      let loadedSoFarLocal = 0
      const allOrders = await fetchDateRangeConcurrent<OrderHeaderRow>({
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
              .select('id, location_id, order_finalized_at, final_price'))
              .gte('order_finalized_at', subStartIso).lte('order_finalized_at', subEndIso)
              .order('order_finalized_at', { ascending: true })
              .order('id', { ascending: true }).limit(PAGE)
            if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
            const { data: pageData, error: err } = await q
            if (!err) return (pageData ?? []) as OrderHeaderRow[]
            lastErr = err.message
            if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
          }
          throw new Error(`${lastErr ?? 'Failed to load orders'} — loaded ${loadedSoFarLocal.toLocaleString()} order(s) before this happened`)
        },
      })
      if (cancelled) return

      const orderIds = allOrders.map((o) => o.id)
      let vehRows: VehicleRow[] = []
      if (orderIds.length) {
        const chunksPerTable = Math.ceil(orderIds.length / 200)
        if (!cancelled) setDetailProgress({ loaded: 0, total: chunksPerTable })
        vehRows = await fetchByOrderIds<VehicleRow>('droptop_order_vehicles', orderIds,
          'order_id, vin, license_plate, vehicle_name, vin_vehicle_make, vin_vehicle_model, vin_vehicle_year, mileage',
          () => { if (!cancelled) setDetailProgress((p) => (p ? { ...p, loaded: p.loaded + 1 } : p)) })
      }
      if (cancelled) return

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

  const aggRows = useMemo((): VehicleAgg[] => {
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
        a = { key, shopLabel, year: v.vin_vehicle_year, make: v.vin_vehicle_make, model: v.vin_vehicle_model, mileage: v.mileage, visits: 0, totalTicket: 0 }
        byKey.set(key, a)
      }
      a.visits++
      a.totalTicket += order.final_price ?? 0
      if (v.mileage != null && (a.mileage == null || v.mileage > a.mileage)) a.mileage = v.mileage
    }
    return [...byKey.values()].sort((a, b) => b.visits - a.visits)
  }, [vehiclesInScope, ordersById, filterYears, filterMakes, filterModels, groupMode, idToLabel])

  function exportRows(format: 'csv' | 'xlsx') {
    if (!aggRows.length) { toast.error('Nothing to export for this selection'); return }
    setExporting(format)
    try {
      const headers = groupMode === 'by-shop'
        ? ['Shop', 'Year', 'Make', 'Model', 'Mileage', 'Visits', 'Avg Ticket']
        : ['Year', 'Make', 'Model', 'Mileage', 'Visits', 'Avg Ticket']
      const rows = aggRows.map((a) => {
        const base = [String(a.year ?? '—'), a.make ?? '—', a.model ?? '—', a.mileage != null ? String(Math.round(a.mileage)) : '—', String(a.visits), (a.totalTicket / a.visits).toFixed(2)]
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
          fraction={
            detailProgress ? detailProgress.loaded / detailProgress.total
              : loadProgress.total ? loadProgress.loaded / loadProgress.total : null
          }
          countText={
            detailProgress
              ? `Loading vehicle detail — ${detailProgress.loaded.toLocaleString()} of ${detailProgress.total.toLocaleString()} batches (${Math.min(100, Math.round((detailProgress.loaded / detailProgress.total) * 100))}%)`
              : loadProgress.total
                ? `Loading orders — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
                : loadProgress.loaded > 0
                  ? `Loading orders — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                  : 'Loading orders…'
          }
          messages={[
            'Pulling order headers…',
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
              <p className="text-lg font-heading font-bold text-navy">{aggRows.length.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Visits</p>
              <p className="text-lg font-heading font-bold text-navy">{aggRows.reduce((s, a) => s + a.visits, 0).toLocaleString()}</p>
            </CardBody></Card>
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" loading={exporting === 'csv'} onClick={() => exportRows('csv')}>Export CSV</Button>
            <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} onClick={() => exportRows('xlsx')}>Export XLSX</Button>
          </div>

          {aggRows.length === 0 ? (
            <Card><CardBody>
              <p className="text-xs font-mono text-inky/60">No vehicle data for this selection — either no orders in range, or none of them have a matched vehicle yet.</p>
            </CardBody></Card>
          ) : (
            <div className="overflow-x-auto rounded border border-navy/30 max-h-[70vh] overflow-y-auto">
              <table className="w-full text-xs font-mono">
                <thead className="bg-navy text-cream sticky top-0">
                  <tr>
                    {groupMode === 'by-shop' && <th className="px-3 py-1.5 text-left">Shop</th>}
                    <th className="px-3 py-1.5 text-left">Year</th>
                    <th className="px-3 py-1.5 text-left">Make</th>
                    <th className="px-3 py-1.5 text-left">Model</th>
                    <th className="px-3 py-1.5 text-right">Mileage</th>
                    <th className="px-3 py-1.5 text-right">Visits</th>
                    <th className="px-3 py-1.5 text-right">Avg Ticket</th>
                  </tr>
                </thead>
                <tbody>
                  {aggRows.map((a) => (
                    <tr key={a.key} className="odd:bg-cream even:bg-white border-t border-navy/10">
                      {groupMode === 'by-shop' && <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.shopLabel}</td>}
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.year ?? '—'}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.make ?? '—'}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{a.model ?? '—'}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{a.mileage != null ? Math.round(a.mileage).toLocaleString() : '—'}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{a.visits.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(a.totalTicket / a.visits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
