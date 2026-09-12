// Staffing Report — compares Droptop staff clock-in/clock-out data
// (inventory.droptop_time_records, populated by Config → Data Connections'
// Droptop — Staff Time Clock sync) against order volume
// (inventory.droptop_orders) by shop and day, to see whether staffing
// levels track car counts. Template 1 (Data Table) per TABLE_TEMPLATES.md —
// this is a browse/sort/filter/export shape, nothing two-dimensional or
// inline-editable about it.
import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Card, CardBody, MultiSelectDropdown } from '@/components/ui'

interface TimeRecordRow { location_id: string; droptop_user_id: string; clock_in: string; hours: number | null }
interface OrderCountRow { location_id: string | null; order_finalized_at: string | null }

interface ReportRow {
  key: string
  shopLabel: string
  date: string
  staffCount: number
  totalHours: number
  orders: number
  ordersPerLaborHour: number | null
}

// Same defensive pagination as every other page in this app that learned
// the hard way PostgREST silently caps every response at however many rows
// the project's "Max Rows" setting allows, regardless of what .limit()
// asks for — looping until a genuinely short page comes back, not trusting
// a single request to have gotten everything.
const PAGE = 1000
async function fetchAllPages<T>(build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    all.push(...batch)
    if (batch.length < PAGE) break
  }
  return all
}

export function StaffingReportPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — same as Droptop Orders/Customer Heatmap (franchise
  // shops included by default; this is Droptop data, not inventory-scoped).
  const loc = useLocations('other')
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } =
    useDateRangePeriod('staffing-report:period', 'last_week')

  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [shopLabels, setShopLabels] = useState<string[]>([])

  const [timeRecords, setTimeRecords] = useState<TimeRecordRow[]>([])
  const [orders, setOrders] = useState<OrderCountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

  // Region/Market/AM/Shop — same shape as Droptop Orders' own filter set.
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
    if (!filterRegions.length && !filterMarkets.length && !filterAMs.length && !shopIds.length) return null
    const ids = new Set<string>()
    for (const l of loc.locations) {
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) continue
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) continue
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) continue
      if (shopIds.length && !shopIds.includes(l.id)) continue
      ids.add(l.id)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets, filterAMs, shopIds])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`
    async function run() {
      const [tr, ord] = await Promise.all([
        fetchAllPages<TimeRecordRow>((from) => sb.schema('inventory').from('droptop_time_records')
          .select('location_id, droptop_user_id, clock_in, hours')
          .eq('company_id', companyId).gte('clock_in', startIso).lte('clock_in', endIso)
          .order('clock_in', { ascending: true }).range(from, from + PAGE - 1)),
        fetchAllPages<OrderCountRow>((from) => sb.schema('inventory').from('droptop_orders')
          .select('location_id, order_finalized_at')
          .eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
          .order('order_finalized_at', { ascending: true }).range(from, from + PAGE - 1)),
      ])
      if (cancelled) return
      setTimeRecords(tr)
      setOrders(ord)
      setLoading(false)
    }
    run().catch((e) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : 'Failed to load staffing data')
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [companyId, range.start, range.end])

  const rows = useMemo((): ReportRow[] => {
    const byKey = new Map<string, { locationId: string; date: string; staff: Set<string>; hours: number; orders: number }>()
    for (const t of timeRecords) {
      if (allowedLocationIds && !allowedLocationIds.has(t.location_id)) continue
      const date = t.clock_in.slice(0, 10)
      const key = `${t.location_id}|${date}`
      const e = byKey.get(key) ?? { locationId: t.location_id, date, staff: new Set<string>(), hours: 0, orders: 0 }
      e.staff.add(t.droptop_user_id)
      e.hours += t.hours ?? 0
      byKey.set(key, e)
    }
    for (const o of orders) {
      if (!o.location_id || !o.order_finalized_at) continue
      if (allowedLocationIds && !allowedLocationIds.has(o.location_id)) continue
      const date = o.order_finalized_at.slice(0, 10)
      const key = `${o.location_id}|${date}`
      const e = byKey.get(key) ?? { locationId: o.location_id, date, staff: new Set<string>(), hours: 0, orders: 0 }
      e.orders += 1
      byKey.set(key, e)
    }
    return [...byKey.values()]
      .map((e) => ({
        key: `${e.locationId}|${e.date}`,
        shopLabel: loc.labelOf(e.locationId),
        date: e.date,
        staffCount: e.staff.size,
        totalHours: Math.round(e.hours * 100) / 100,
        orders: e.orders,
        ordersPerLaborHour: e.hours > 0 ? Math.round((e.orders / e.hours) * 100) / 100 : null,
      }))
      .sort((a, b) => (a.date === b.date ? a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }) : a.date.localeCompare(b.date)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeRecords, orders, allowedLocationIds, loc.labelOf])

  const col = useMemo(() => createColumnHelper<ReportRow>(), [])
  const columns = useMemo(() => [
    col.accessor('date', { header: 'Date', cell: (i) => new Date(`${i.getValue()}T00:00:00`).toLocaleDateString() }),
    col.accessor('shopLabel', { header: 'Shop', cell: (i) => i.getValue() }),
    col.accessor('staffCount', { header: 'Staff', cell: (i) => i.getValue() }),
    col.accessor('totalHours', { header: 'Hours', cell: (i) => i.getValue().toFixed(2) }),
    col.accessor('orders', { header: 'Orders', cell: (i) => i.getValue() }),
    col.accessor('ordersPerLaborHour', {
      header: 'Orders / Labor Hour',
      cell: (i) => { const v = i.getValue(); return v != null ? v.toFixed(2) : '—' },
    }),
  ], [col])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns, { persistKey: 'staffing-report' })

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Staffing Report</h1>
        <p className="text-xs text-inky mt-0.5">
          Compares staff clocked-in hours/headcount against Droptop order volume, by shop and day. Populated by
          Config → Data Connections' Droptop — Staff Time Clock sync.
        </p>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} customEnd={customEnd}
          onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} earliestDate={null} />
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
          <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels} placeholder="All Shops" countNoun="shops" searchable />
        </div>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {loading ? (
        <LoadingProgress
          fraction={null}
          countText="Loading staffing data…"
          messages={['Pulling clock-in/clock-out records…', 'Pulling order counts…', 'Matching by shop and day…']}
        />
      ) : rows.length === 0 ? (
        <Card><CardBody>
          <p className="text-xs font-mono text-inky/60">
            No staffing data for this period/filter — run the Droptop — Staff Time Clock sync from Data Connections
            first (Config → Data Connections), then come back.
          </p>
        </CardBody></Card>
      ) : (
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename={`staffing-report-${range.start}-to-${range.end}`}
        />
      )}
    </div>
  )
}
