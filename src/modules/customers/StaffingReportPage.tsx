// Staffing Report — compares Droptop staff clock-in/clock-out data
// (inventory.droptop_time_records, populated by Config → Data Connections'
// Droptop — Staff Time Clock sync) against order volume
// (inventory.droptop_orders), to see whether staffing levels track car
// counts. The Rollup tab is a 3-level drill-down (shop for the whole
// period -> day -> employee timecard) rather than one flat row per
// (shop, date) — that shape doesn't fit any of the 5 templates in
// TABLE_TEMPLATES.md (not a flat browse/filter list, not a matrix), so it's
// hand-rolled rather than forced into DataTable/useTable, matching that
// doc's own precedent for shapes without a shared component yet (Templates
// 4/5). Sort/filter/export apply at the shop-rollup level only.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { Card, CardBody, MultiSelectDropdown } from '@/components/ui'

// hours/hourly_wage are Postgres `numeric` columns — PostgREST serializes
// those as JSON strings (not numbers), to avoid float-precision surprises.
// Read through numHours()/numWage() below rather than using the raw value
// directly in arithmetic; a bare `0 += "0.3"` silently string-concatenates
// instead of adding.
interface TimeRecordRow {
  location_id: string
  droptop_user_id: string
  first_name: string | null
  last_name: string | null
  clock_in: string
  clock_out: string | null
  hours: string | number | null
  hourly_wage: string | number | null
}
function numHours(t: Pick<TimeRecordRow, 'hours'>): number { return Number(t.hours) || 0 }
function numWage(t: Pick<TimeRecordRow, 'hourly_wage'>): number { return Number(t.hourly_wage) || 0 }
interface OrderCountRow { location_id: string | null; order_finalized_at: string | null }

interface DayRow { date: string; staffCount: number; hours: number; orders: number; ordersPerLaborHour: number | null }
interface ShopRollupRow {
  locationId: string
  shopLabel: string
  staffCount: number
  totalHours: number
  totalOrders: number
  ordersPerLaborHour: number | null
  days: DayRow[]
}

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

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

function Chevron({ open }: { open: boolean }) {
  return (
    <span className={`inline-block transition-transform text-inky/50 ${open ? 'rotate-90' : ''}`} style={{ width: 12 }}>▶</span>
  )
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

  // Which shop rows / (shop, day) rows are currently expanded.
  const [expandedShops, setExpandedShops] = useState<Set<string>>(new Set())
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  function toggleShop(id: string) {
    setExpandedShops((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleDay(key: string) {
    setExpandedDays((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  }

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
          .select('location_id, droptop_user_id, first_name, last_name, clock_in, clock_out, hours, hourly_wage')
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

  // Orders-per-shop-per-day — built once, reused by both the shop rollup
  // and each shop's daily breakdown.
  const ordersByShopDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of orders) {
      if (!o.location_id || !o.order_finalized_at) continue
      if (allowedLocationIds && !allowedLocationIds.has(o.location_id)) continue
      const key = `${o.location_id}|${o.order_finalized_at.slice(0, 10)}`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, allowedLocationIds])

  const filteredTimeRecords = useMemo(
    () => allowedLocationIds ? timeRecords.filter((t) => allowedLocationIds.has(t.location_id)) : timeRecords,
    [timeRecords, allowedLocationIds],
  )

  // Level 1: one row per shop for the whole selected period, with its own
  // day-by-day breakdown (Level 2) nested inside — computed together since
  // both need the same per-(shop,day) grouping pass.
  const shopRollups = useMemo((): ShopRollupRow[] => {
    const byShopDay = new Map<string, { staff: Set<string>; hours: number }>()
    for (const t of filteredTimeRecords) {
      const date = t.clock_in.slice(0, 10)
      const key = `${t.location_id}|${date}`
      const e = byShopDay.get(key) ?? { staff: new Set<string>(), hours: 0 }
      e.staff.add(t.droptop_user_id)
      e.hours += numHours(t)
      byShopDay.set(key, e)
    }
    const byShop = new Map<string, { staff: Set<string>; hours: number; orders: number; days: DayRow[] }>()
    for (const [key, e] of byShopDay) {
      const [locationId, date] = key.split('|')
      const dayOrders = ordersByShopDay.get(key) ?? 0
      const shop = byShop.get(locationId) ?? { staff: new Set<string>(), hours: 0, orders: 0, days: [] }
      for (const s of e.staff) shop.staff.add(s)
      shop.hours += e.hours
      shop.orders += dayOrders
      shop.days.push({
        date,
        staffCount: e.staff.size,
        hours: Math.round(e.hours * 100) / 100,
        orders: dayOrders,
        ordersPerLaborHour: e.hours > 0 ? Math.round((dayOrders / e.hours) * 100) / 100 : null,
      })
      byShop.set(locationId, shop)
    }
    // A shop with orders but zero clocked staff in this period still needs
    // its own rollup row (an obvious staffing gap, not something to hide) —
    // ordersByShopDay may reference shops that never appear in byShopDay.
    for (const key of ordersByShopDay.keys()) {
      const [locationId] = key.split('|')
      if (!byShop.has(locationId)) byShop.set(locationId, { staff: new Set<string>(), hours: 0, orders: 0, days: [] })
    }
    for (const [key] of ordersByShopDay) {
      const [locationId, date] = key.split('|')
      const shop = byShop.get(locationId)!
      if (!shop.days.some((d) => d.date === date)) {
        const dayOrders = ordersByShopDay.get(key) ?? 0
        shop.orders += dayOrders
        shop.days.push({ date, staffCount: 0, hours: 0, orders: dayOrders, ordersPerLaborHour: null })
      }
    }
    return [...byShop.entries()]
      .map(([locationId, s]) => ({
        locationId,
        shopLabel: loc.labelOf(locationId),
        staffCount: s.staff.size,
        totalHours: Math.round(s.hours * 100) / 100,
        totalOrders: s.orders,
        ordersPerLaborHour: s.hours > 0 ? Math.round((s.orders / s.hours) * 100) / 100 : null,
        days: s.days.sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTimeRecords, ordersByShopDay, loc.labelOf])

  // Level 3: individual timecard punches for one (shop, day) — built lazily
  // per expanded day rather than for every day up front.
  function timecardsFor(locationId: string, date: string): TimeRecordRow[] {
    return filteredTimeRecords
      .filter((t) => t.location_id === locationId && t.clock_in.slice(0, 10) === date)
      .sort((a, b) => a.clock_in.localeCompare(b.clock_in))
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Staffing Report</h1>
        <p className="text-xs text-inky mt-0.5">
          Compares staff clocked-in hours/headcount against Droptop order volume. Click a shop to see its daily
          breakdown for the period; click a day to see that day's timecards by employee. Populated by Config → Data
          Connections' Droptop — Staff Time Clock sync.
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
      ) : shopRollups.length === 0 ? (
        <Card><CardBody>
          <p className="text-xs font-mono text-inky/60">
            No staffing data for this period/filter — run the Droptop — Staff Time Clock sync from Data Connections
            first (Config → Data Connections), then come back.
          </p>
        </CardBody></Card>
      ) : (
        <div className="overflow-x-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-cream">
              <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                <th className="px-3 py-2 text-left">Shop</th>
                <th className="px-3 py-2 text-right">Staff</th>
                <th className="px-3 py-2 text-right">Hours</th>
                <th className="px-3 py-2 text-right">Orders</th>
                <th className="px-3 py-2 text-right">Orders / Labor Hour</th>
              </tr>
            </thead>
            <tbody>
              {shopRollups.map((shop) => {
                const shopOpen = expandedShops.has(shop.locationId)
                return (
                  <Fragment key={shop.locationId}>
                    <tr
                      onClick={() => toggleShop(shop.locationId)}
                      className="border-b border-navy/10 hover:bg-sky/10 cursor-pointer"
                    >
                      <td className="px-3 py-2 text-navy font-bold flex items-center gap-1.5">
                        <Chevron open={shopOpen} /> {shop.shopLabel}
                      </td>
                      <td className="px-3 py-2 text-right text-navy tabular-nums">{shop.staffCount}</td>
                      <td className="px-3 py-2 text-right text-navy tabular-nums">{shop.totalHours.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right text-navy tabular-nums">{shop.totalOrders}</td>
                      <td className="px-3 py-2 text-right text-navy tabular-nums">{shop.ordersPerLaborHour != null ? shop.ordersPerLaborHour.toFixed(2) : '—'}</td>
                    </tr>
                    {shopOpen && shop.days.map((day) => {
                      const dayKey = `${shop.locationId}|${day.date}`
                      const dayOpen = expandedDays.has(dayKey)
                      return (
                        <Fragment key={dayKey}>
                          <tr
                            onClick={() => toggleDay(dayKey)}
                            className="border-b border-navy/10 bg-navy/[0.02] hover:bg-sky/10 cursor-pointer"
                          >
                            <td className="pl-8 pr-3 py-1.5 text-inky flex items-center gap-1.5">
                              <Chevron open={dayOpen} /> {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                            </td>
                            <td className="px-3 py-1.5 text-right text-inky tabular-nums">{day.staffCount}</td>
                            <td className="px-3 py-1.5 text-right text-inky tabular-nums">{day.hours.toFixed(2)}</td>
                            <td className="px-3 py-1.5 text-right text-inky tabular-nums">{day.orders}</td>
                            <td className="px-3 py-1.5 text-right text-inky tabular-nums">{day.ordersPerLaborHour != null ? day.ordersPerLaborHour.toFixed(2) : '—'}</td>
                          </tr>
                          {dayOpen && (
                            <tr key={`${dayKey}-detail`}>
                              <td colSpan={5} className="pl-8 pr-3 py-2 bg-navy/[0.04]">
                                {(() => {
                                  const cards = timecardsFor(shop.locationId, day.date)
                                  if (!cards.length) return <p className="text-inky/50 italic">No timecards clocked in this day.</p>
                                  return (
                                    <table className="w-full text-[11px] font-mono">
                                      <thead>
                                        <tr className="text-inky/60 uppercase tracking-wide border-b border-navy/20">
                                          <th className="text-left pb-1 pr-3">Employee</th>
                                          <th className="text-left pb-1 pr-3">Clock In</th>
                                          <th className="text-left pb-1 pr-3">Clock Out</th>
                                          <th className="text-right pb-1 pr-3">Hours</th>
                                          <th className="text-right pb-1 pr-3">Wage</th>
                                          <th className="text-right pb-1">Labor $</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {cards.map((c, i) => (
                                          <tr key={i} className="border-b border-navy/5 last:border-0">
                                            <td className="py-1 pr-3 text-navy">{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.droptop_user_id}</td>
                                            <td className="py-1 pr-3 text-inky">{new Date(c.clock_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                                            <td className="py-1 pr-3 text-inky">{c.clock_out ? new Date(c.clock_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                                            <td className="py-1 pr-3 text-right text-navy tabular-nums">{numHours(c).toFixed(2)}</td>
                                            <td className="py-1 pr-3 text-right text-inky tabular-nums">{c.hourly_wage != null ? money(numWage(c)) : '—'}</td>
                                            <td className="py-1 text-right text-navy tabular-nums">{c.hourly_wage != null ? money(numHours(c) * numWage(c)) : '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )
                                })()}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
