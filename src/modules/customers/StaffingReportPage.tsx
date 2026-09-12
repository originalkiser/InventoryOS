// Staffing Report — compares Droptop staff clock-in/clock-out data
// (inventory.droptop_time_records, populated by Config → Data Connections'
// Droptop — Staff Time Clock sync) against order volume/revenue
// (inventory.droptop_orders).
//
// Three tabs:
//  - Rollup: 3-level drill-down for the selected period (shop -> day ->
//    employee timecard). Hand-rolled rather than DataTable/useTable — that
//    shape doesn't fit any of the 5 templates in TABLE_TEMPLATES.md (not a
//    flat browse/filter list, not a matrix), matching that doc's own
//    precedent for shapes without a shared component yet (Templates 4/5).
//  - Summary: company-wide (or filtered) KPIs — orders, labor hours by day
//    of week, labor $ / % of revenue, labor hours per effective car (LHCE).
//    "Effective car" = Finalized orders only (excludes Void/Uncollectible),
//    matching how Droptop Orders/Customer Heatmap already treat revenue.
//  - Labor Hour Forecast: upload a per-(shop, date) forecast, split hourly
//    vs shop-manager, and compare against actual hours as a percent.
//
// The hourly-vs-manager split (Summary doesn't need it; Forecast does) is a
// WAGE-THRESHOLD PROXY, not real data — Droptop's time clock has no role/
// title field at all (confirmed by scanning every distinct key ever present
// across its raw payload: clock_in/out, hours*, hourly_wage,
// overtime_pay_rate, hours_per_week, work_week_start/end — nothing else).
// The threshold is a company setting (Forecast tab), adjustable since it's
// inherently approximate.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useAppSetting } from '@/hooks/useAppSetting'
import { parseDateSafe } from '@/lib/transforms'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import type { ParseResult } from '@/lib/fileParser'
import {
  Card, CardHeader, CardBody, MultiSelectDropdown, Tabs, TabsList, TabsTrigger, TabsContent, Button, Input,
} from '@/components/ui'

// hours/hourly_wage/final_price are Postgres `numeric` columns — PostgREST
// serializes those as JSON strings (not numbers), to avoid float-precision
// surprises. Read through numHours()/numWage() below rather than using the
// raw value directly in arithmetic; a bare `0 += "0.3"` silently
// string-concatenates instead of adding.
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
const round2 = (n: number) => Math.round(n * 100) / 100

interface OrderRow { location_id: string | null; order_finalized_at: string | null; final_price: string | number | null; status: string | null }

// LHCE = Labor Hours / (Effective) Car = hours ÷ orders. This used to be
// named/computed the other way around (orders ÷ hours, i.e. cars per
// labor hour) under the label "Orders / Labor Hour" — caught while
// renaming the column to LHCE: keeping the old formula under the new name
// would have silently shown the RECIPROCAL of what LHCE actually means.
interface DayRow { date: string; staffCount: number; hours: number; orders: number; lhce: number | null }
interface ShopRollupRow {
  locationId: string
  shopLabel: string
  staffCount: number
  totalHours: number
  totalOrders: number
  lhce: number | null
  days: DayRow[]
}

interface ForecastDbRow {
  location_id: string
  forecast_date: string
  hourly_forecast_hours: string | number | null
  manager_forecast_hours: string | number | null
}
interface ForecastCompareRow {
  key: string
  shopLabel: string
  date: string
  hourlyActual: number
  hourlyForecast: number
  hourlyPct: number | null
  managerActual: number
  managerForecast: number
  managerPct: number | null
  totalActual: number
  totalForecast: number
  totalPct: number | null
}

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const pct = (v: number | null) => v == null ? '—' : `${fmtNum(v, 0)}%`
// Thousands-separated, fixed-decimal formatting — a bare .toFixed(2) never
// adds a comma, which is exactly why a lot of these numbers were hard to
// read at real volume (hundreds/thousands of hours or dollars).
function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// Hover callout translating the acronym — native title attr is too crude
// for "here's what this means", so a small custom popover instead.
function InfoTooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="text-inky/50 cursor-help border-b border-dotted border-inky/40">ⓘ</span>
      {open && (
        <span className="absolute z-20 left-1/2 -translate-x-1/2 bottom-full mb-1.5 w-max max-w-[220px] rounded bg-navy text-cream text-[10px] font-mono px-2 py-1.5 shadow-lg whitespace-normal text-center">
          {text}
        </span>
      )}
    </span>
  )
}

// Same defensive pagination as every other page in this app that learned
// the hard way PostgREST silently caps every response at however many rows
// the project's "Max Rows" setting allows, regardless of what .limit()
// asks for — looping until a genuinely short page comes back, not trusting
// a single request to have gotten everything.
const PAGE = 1000
async function fetchAllPages<T>(
  build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  onPage?: (rowsSoFar: number) => void,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    all.push(...batch)
    onPage?.(all.length)
    if (batch.length < PAGE) break
  }
  return all
}

function Chevron({ open }: { open: boolean }) {
  return <span className={`inline-block transition-transform text-inky/50 ${open ? 'rotate-90' : ''}`} style={{ width: 12 }}>▶</span>
}

// Case-insensitive "does any header look like this" match — the forecast
// upload doesn't force an exact column name, since a real workforce-planning
// export's headers vary company to company.
function findHeader(headers: string[], patterns: RegExp[]): string | null {
  for (const h of headers) if (patterns.some((p) => p.test(h))) return h
  return null
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] // Monday..Sunday, Date#getDay() is 0=Sunday
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const PAGE_SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: 'all', label: 'All' },
]

// The 3-level drill-down (shop -> day -> employee timecard), reused by
// both the Rollup tab (its own full page) and the Summary tab (a
// paginated rollup underneath the KPI/day-of-week cards) — each mounted
// instance keeps its own expand/page state independently, there's nothing
// shared between the two placements.
function RollupTable({
  rows, timecardsFor, exportFilenameBase,
}: {
  rows: ShopRollupRow[]
  timecardsFor: (locationId: string, date: string) => TimeRecordRow[]
  exportFilenameBase: string
}) {
  const [expandedShops, setExpandedShops] = useState<Set<string>>(new Set())
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set())
  const [pageSize, setPageSize] = useState<string>('25')
  const [page, setPage] = useState(0)
  useEffect(() => { setPage(0) }, [rows, pageSize])

  function toggleShop(id: string) {
    setExpandedShops((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleDay(key: string) {
    setExpandedDays((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n })
  }

  const sizeNum = pageSize === 'all' ? rows.length || 1 : Number(pageSize)
  const totalPages = Math.max(1, Math.ceil(rows.length / sizeNum))
  const pagedRows = pageSize === 'all' ? rows : rows.slice(page * sizeNum, (page + 1) * sizeNum)

  // "Pivot table with drill-downs" export — one row per level (Shop / Day /
  // Employee), a Level column instead of separate sheets, so the whole
  // hierarchy for the period is in one flat, filterable/groupable file
  // matching what's on screen (shop summary, then that shop's daily
  // summaries, then each day's employee timecards) rather than just the
  // top-level shop rows.
  function exportRollup() {
    const headers = ['Level', 'Shop', 'Date', 'Employee', 'Staff', 'Hours', 'Orders', 'LHCE', 'Wage', 'Labor $']
    const dataRows: (string | number)[][] = []
    for (const shop of rows) {
      dataRows.push(['Shop', shop.shopLabel, '', '', shop.staffCount, shop.totalHours, shop.totalOrders, shop.lhce ?? '', '', ''])
      for (const day of shop.days) {
        dataRows.push(['Day', shop.shopLabel, day.date, '', day.staffCount, day.hours, day.orders, day.lhce ?? '', '', ''])
        for (const c of timecardsFor(shop.locationId, day.date)) {
          const wage = c.hourly_wage != null ? numWage(c) : ''
          dataRows.push([
            'Employee', shop.shopLabel, day.date,
            [c.first_name, c.last_name].filter(Boolean).join(' ') || c.droptop_user_id,
            '', numHours(c), '', '', wage, wage !== '' ? numHours(c) * numWage(c) : '',
          ])
        }
      }
    }
    const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const csv = [headers, ...dataRows].map((r) => r.map(esc).join(',')).join('\n')
    triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${exportFilenameBase}.csv`)
    toast.success('Rollup exported')
  }

  if (rows.length === 0) {
    return (
      <Card><CardBody>
        <p className="text-xs font-mono text-inky/60">
          No staffing data for this period/filter — run the Droptop — Staff Time Clock sync from Data Connections
          first (Config → Data Connections), then come back.
        </p>
      </CardBody></Card>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Show</span>
          {PAGE_SIZE_OPTIONS.map((o) => (
            <button key={o.value} onClick={() => setPageSize(o.value)}
              className={['px-2 py-1 rounded border text-[11px] font-mono transition-colors',
                pageSize === o.value ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
              {o.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={exportRollup}>Export</Button>
      </div>

      <div className="overflow-x-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-cream">
            <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
              <th className="px-3 py-2 text-left">Shop</th>
              <th className="px-3 py-2 text-right">Staff</th>
              <th className="px-3 py-2 text-right">Hours</th>
              <th className="px-3 py-2 text-right">Orders</th>
              <th className="px-3 py-2 text-right">
                <span className="inline-flex items-center gap-1">LHCE <InfoTooltip text="Labor Hours / (Effective) Car" /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pagedRows.map((shop) => {
              const shopOpen = expandedShops.has(shop.locationId)
              return (
                <Fragment key={shop.locationId}>
                  <tr onClick={() => toggleShop(shop.locationId)} className="border-b border-navy/10 hover:bg-sky/10 cursor-pointer">
                    <td className="px-3 py-2 text-navy font-bold flex items-center gap-1.5">
                      <Chevron open={shopOpen} /> {shop.shopLabel}
                    </td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.staffCount, 0)}</td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.totalHours)}</td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.totalOrders, 0)}</td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.lhce)}</td>
                  </tr>
                  {shopOpen && shop.days.map((day) => {
                    const dayKey = `${shop.locationId}|${day.date}`
                    const dayOpen = expandedDays.has(dayKey)
                    return (
                      <Fragment key={dayKey}>
                        <tr onClick={() => toggleDay(dayKey)} className="border-b border-navy/10 bg-navy/[0.02] hover:bg-sky/10 cursor-pointer">
                          <td className="pl-8 pr-3 py-1.5 text-inky flex items-center gap-1.5">
                            <Chevron open={dayOpen} /> {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.staffCount, 0)}</td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.hours)}</td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.orders, 0)}</td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.lhce)}</td>
                        </tr>
                        {dayOpen && (
                          <tr>
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
                                          <td className="py-1 pr-3 text-right text-navy tabular-nums">{fmtNum(numHours(c))}</td>
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

      {pageSize !== 'all' && totalPages > 1 && (
        <div className="flex items-center justify-between text-[11px] font-mono text-inky">
          <span>Page {page + 1} of {totalPages} ({rows.length} shops)</span>
          <div className="flex gap-1">
            <Button size="sm" variant="secondary" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
            <Button size="sm" variant="secondary" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>Next</Button>
          </div>
        </div>
      )}
    </div>
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
  const [managerWageThreshold, setManagerWageThreshold] = useAppSetting<number>('staffing_manager_wage_threshold', 19)
  const [thresholdDraft, setThresholdDraft] = useState<string>(String(managerWageThreshold))
  useEffect(() => { setThresholdDraft(String(managerWageThreshold)) }, [managerWageThreshold])

  // Shared filters — same Region/Market/AM/Shop shape as Droptop Orders,
  // minus the order-specific dropdowns (Package/Product ID/Vehicle/Fleet)
  // that don't apply to staffing. Apply across all three tabs.
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [shopLabels, setShopLabels] = useState<string[]>([])

  const [timeRecords, setTimeRecords] = useState<TimeRecordRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Real progress instead of a bare spinner — same pattern as Droptop
  // Orders' full-detail load: a cheap COUNT-only request up front gives a
  // denominator, then each page ticks `loaded` up as it lands. This used
  // to just await fetchAllPages with no progress reporting at all, so the
  // page silently loaded everything in the background with no visible
  // indication of how far along it was.
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
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
    setLoadProgress({ loaded: 0, total: null })
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`
    async function run() {
      // Best-effort — if either count fails for any reason the load still
      // proceeds, just without a percentage (falls back to a running
      // "N loaded so far" count instead, same convention as Droptop Orders).
      const [{ count: trCount }, { count: ordCount }] = await Promise.all([
        sb.schema('inventory').from('droptop_time_records').select('location_id', { count: 'exact', head: true })
          .eq('company_id', companyId).gte('clock_in', startIso).lte('clock_in', endIso),
        sb.schema('inventory').from('droptop_orders').select('location_id', { count: 'exact', head: true })
          .eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso),
      ])
      if (cancelled) return
      const total = (trCount ?? 0) + (ordCount ?? 0)
      setLoadProgress({ loaded: 0, total: total > 0 ? total : null })

      let trLoaded = 0
      let ordLoaded = 0
      const tick = () => { if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: trLoaded + ordLoaded })) }

      const [tr, ord] = await Promise.all([
        fetchAllPages<TimeRecordRow>((from) => sb.schema('inventory').from('droptop_time_records')
          .select('location_id, droptop_user_id, first_name, last_name, clock_in, clock_out, hours, hourly_wage')
          .eq('company_id', companyId).gte('clock_in', startIso).lte('clock_in', endIso)
          .order('clock_in', { ascending: true }).range(from, from + PAGE - 1), (n) => { trLoaded = n; tick() }),
        fetchAllPages<OrderRow>((from) => sb.schema('inventory').from('droptop_orders')
          .select('location_id, order_finalized_at, final_price, status')
          .eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
          .order('order_finalized_at', { ascending: true }).range(from, from + PAGE - 1), (n) => { ordLoaded = n; tick() }),
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

  const filteredTimeRecords = useMemo(
    () => allowedLocationIds ? timeRecords.filter((t) => allowedLocationIds.has(t.location_id)) : timeRecords,
    [timeRecords, allowedLocationIds],
  )
  // "Effective car" = Finalized orders only (excludes Void/Uncollectible) —
  // matches how Droptop Orders/Customer Heatmap already treat revenue.
  const filteredOrdersFinalized = useMemo(
    () => orders.filter((o) => o.location_id && o.status === 'Finalized' && (!allowedLocationIds || allowedLocationIds.has(o.location_id))),
    [orders, allowedLocationIds],
  )

  // ---- Rollup tab -------------------------------------------------------
  const ordersByShopDay = useMemo(() => {
    const m = new Map<string, number>()
    for (const o of filteredOrdersFinalized) {
      const key = `${o.location_id}|${o.order_finalized_at!.slice(0, 10)}`
      m.set(key, (m.get(key) ?? 0) + 1)
    }
    return m
  }, [filteredOrdersFinalized])

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
        date, staffCount: e.staff.size, hours: round2(e.hours), orders: dayOrders,
        lhce: dayOrders > 0 ? round2(e.hours / dayOrders) : null,
      })
      byShop.set(locationId, shop)
    }
    // A shop with orders but zero clocked staff in this period still needs
    // its own rollup row (an obvious staffing gap, not something to hide).
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
        shop.days.push({ date, staffCount: 0, hours: 0, orders: dayOrders, lhce: null })
      }
    }
    return [...byShop.entries()]
      .map(([locationId, s]) => ({
        locationId, shopLabel: loc.labelOf(locationId), staffCount: s.staff.size,
        totalHours: round2(s.hours), totalOrders: s.orders,
        lhce: s.orders > 0 ? round2(s.hours / s.orders) : null,
        days: s.days.sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTimeRecords, ordersByShopDay, loc.labelOf])

  function timecardsFor(locationId: string, date: string): TimeRecordRow[] {
    return filteredTimeRecords
      .filter((t) => t.location_id === locationId && t.clock_in.slice(0, 10) === date)
      .sort((a, b) => a.clock_in.localeCompare(b.clock_in))
  }

  // ---- Summary tab -------------------------------------------------------
  const summary = useMemo(() => {
    const totalOrders = filteredOrdersFinalized.length
    const totalHours = filteredTimeRecords.reduce((sum, t) => sum + numHours(t), 0)
    const laborDollars = filteredTimeRecords.reduce((sum, t) => sum + numHours(t) * numWage(t), 0)
    const revenue = filteredOrdersFinalized.reduce((sum, o) => sum + (Number(o.final_price) || 0), 0)
    return {
      totalOrders,
      totalHours: round2(totalHours),
      laborDollars: round2(laborDollars),
      revenue: round2(revenue),
      laborPctOfRevenue: revenue > 0 ? round2((laborDollars / revenue) * 100) : null,
      lhce: totalOrders > 0 ? round2(totalHours / totalOrders) : null,
    }
  }, [filteredTimeRecords, filteredOrdersFinalized])

  const dayOfWeekBreakdown = useMemo(() => {
    const dateCounts = new Array(7).fill(0) // index = Date#getDay(), 0=Sunday
    const start = new Date(`${range.start}T00:00:00`)
    const end = new Date(`${range.end}T00:00:00`)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dateCounts[d.getDay()]++

    const hoursByDow = new Array(7).fill(0)
    const laborDollarsByDow = new Array(7).fill(0)
    for (const t of filteredTimeRecords) {
      const d = new Date(`${t.clock_in.slice(0, 10)}T00:00:00`)
      const dow = d.getDay()
      hoursByDow[dow] += numHours(t)
      laborDollarsByDow[dow] += numHours(t) * numWage(t)
    }
    const ordersByDow = new Array(7).fill(0)
    const revenueByDow = new Array(7).fill(0)
    for (const o of filteredOrdersFinalized) {
      const d = new Date(`${o.order_finalized_at!.slice(0, 10)}T00:00:00`)
      const dow = d.getDay()
      ordersByDow[dow]++
      revenueByDow[dow] += Number(o.final_price) || 0
    }
    return WEEKDAY_ORDER.map((dowIndex, i) => {
      const hours = hoursByDow[dowIndex]
      const count = dateCounts[dowIndex]
      const revenue = revenueByDow[dowIndex]
      const laborDollars = laborDollarsByDow[dowIndex]
      const orders = ordersByDow[dowIndex]
      return {
        name: WEEKDAY_NAMES[i],
        count,
        totalHours: round2(hours),
        avgHoursPerDay: count > 0 ? round2(hours / count) : null,
        laborPctOfRevenue: revenue > 0 ? round2((laborDollars / revenue) * 100) : null,
        lhce: orders > 0 ? round2(hours / orders) : null,
      }
    })
  }, [range.start, range.end, filteredTimeRecords, filteredOrdersFinalized])

  // ---- Labor Hour Forecast tab -------------------------------------------
  const [forecastRows, setForecastRows] = useState<ForecastDbRow[]>([])
  const [forecastLoading, setForecastLoading] = useState(true)
  const [forecastError, setForecastError] = useState<string | null>(null)

  const loadForecast = useCallback(async () => {
    if (!companyId) return
    setForecastLoading(true)
    setForecastError(null)
    try {
      const sb = supabase as any
      const rows = await fetchAllPages<ForecastDbRow>((from) => sb.schema('inventory').from('labor_hour_forecast')
        .select('location_id, forecast_date, hourly_forecast_hours, manager_forecast_hours')
        .eq('company_id', companyId).gte('forecast_date', range.start).lte('forecast_date', range.end)
        .range(from, from + PAGE - 1))
      setForecastRows(rows)
    } catch (e) {
      setForecastError(e instanceof Error ? e.message : 'Failed to load forecast data')
    } finally {
      setForecastLoading(false)
    }
  }, [companyId, range.start, range.end])
  useEffect(() => { loadForecast() }, [loadForecast])

  interface ParsedForecastRow { shopRaw: string; locationId: string | null; date: string | null; hourlyHours: number; managerHours: number }
  const [uploadPreview, setUploadPreview] = useState<ParsedForecastRow[] | null>(null)
  const [importing, setImporting] = useState(false)

  function handleParsed(result: ParseResult) {
    const shopHeader = findHeader(result.headers, [/shop/i, /location/i])
    const dateHeader = findHeader(result.headers, [/date/i])
    const hourlyHeader = findHeader(result.headers, [/hourly/i])
    const managerHeader = findHeader(result.headers, [/manager|mgr/i])
    if (!shopHeader || !dateHeader || (!hourlyHeader && !managerHeader)) {
      toast.error('Could not find Shop, Date, and Hourly/Manager Hours columns in this file — check the headers match what\'s expected below.')
      return
    }
    const parsed: ParsedForecastRow[] = result.rows.map((row) => {
      const shopRaw = row[shopHeader] ?? ''
      const dateVal = parseDateSafe(row[dateHeader] ?? '')
      return {
        shopRaw,
        locationId: loc.resolveId(shopRaw),
        date: dateVal ? format(dateVal, 'yyyy-MM-dd') : null,
        hourlyHours: hourlyHeader ? Number(row[hourlyHeader]) || 0 : 0,
        managerHours: managerHeader ? Number(row[managerHeader]) || 0 : 0,
      }
    })
    setUploadPreview(parsed)
  }

  async function confirmImport() {
    if (!uploadPreview || !companyId) return
    const valid = uploadPreview.filter((r) => r.locationId && r.date)
    if (!valid.length) { toast.error('No rows had both a matching shop and a valid date — nothing to import'); return }
    setImporting(true)
    try {
      const sb = supabase as any
      const BATCH = 500
      for (let i = 0; i < valid.length; i += BATCH) {
        const slice = valid.slice(i, i + BATCH).map((r) => ({
          company_id: companyId, location_id: r.locationId, forecast_date: r.date,
          hourly_forecast_hours: r.hourlyHours, manager_forecast_hours: r.managerHours,
          updated_by: profile?.id ?? null, updated_at: new Date().toISOString(),
        }))
        const { error } = await sb.schema('inventory').from('labor_hour_forecast')
          .upsert(slice, { onConflict: 'company_id,location_id,forecast_date' })
        if (error) throw new Error(error.message)
      }
      toast.success(`Imported ${valid.length} forecast row(s)`)
      setUploadPreview(null)
      loadForecast()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const forecastCompareRows = useMemo((): ForecastCompareRow[] => {
    const actualByKey = new Map<string, { hourly: number; manager: number }>()
    for (const t of filteredTimeRecords) {
      const date = t.clock_in.slice(0, 10)
      const key = `${t.location_id}|${date}`
      const e = actualByKey.get(key) ?? { hourly: 0, manager: 0 }
      const h = numHours(t)
      if (numWage(t) >= managerWageThreshold) e.manager += h; else e.hourly += h
      actualByKey.set(key, e)
    }
    const rows: ForecastCompareRow[] = []
    for (const f of forecastRows) {
      if (allowedLocationIds && !allowedLocationIds.has(f.location_id)) continue
      const key = `${f.location_id}|${f.forecast_date}`
      const a = actualByKey.get(key) ?? { hourly: 0, manager: 0 }
      const hourlyForecast = Number(f.hourly_forecast_hours) || 0
      const managerForecast = Number(f.manager_forecast_hours) || 0
      rows.push({
        key, shopLabel: loc.labelOf(f.location_id), date: f.forecast_date,
        hourlyActual: round2(a.hourly), hourlyForecast: round2(hourlyForecast),
        hourlyPct: hourlyForecast > 0 ? round2((a.hourly / hourlyForecast) * 100) : null,
        managerActual: round2(a.manager), managerForecast: round2(managerForecast),
        managerPct: managerForecast > 0 ? round2((a.manager / managerForecast) * 100) : null,
        totalActual: round2(a.hourly + a.manager), totalForecast: round2(hourlyForecast + managerForecast),
        totalPct: (hourlyForecast + managerForecast) > 0 ? round2(((a.hourly + a.manager) / (hourlyForecast + managerForecast)) * 100) : null,
      })
    }
    return rows.sort((a, b) => (a.date === b.date ? a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }) : a.date.localeCompare(b.date)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastRows, filteredTimeRecords, allowedLocationIds, loc.labelOf, managerWageThreshold])

  const forecastTotals = useMemo(() => forecastCompareRows.reduce((acc, r) => ({
    hourlyActual: acc.hourlyActual + r.hourlyActual, hourlyForecast: acc.hourlyForecast + r.hourlyForecast,
    managerActual: acc.managerActual + r.managerActual, managerForecast: acc.managerForecast + r.managerForecast,
    totalActual: acc.totalActual + r.totalActual, totalForecast: acc.totalForecast + r.totalForecast,
  }), { hourlyActual: 0, hourlyForecast: 0, managerActual: 0, managerForecast: 0, totalActual: 0, totalForecast: 0 }), [forecastCompareRows])

  const fcCol = useMemo(() => createColumnHelper<ForecastCompareRow>(), [])
  const forecastColumns = useMemo(() => [
    fcCol.accessor('date', { header: 'Date', cell: (i) => new Date(`${i.getValue()}T00:00:00`).toLocaleDateString() }),
    fcCol.accessor('shopLabel', { header: 'Shop', cell: (i) => i.getValue() }),
    fcCol.accessor('hourlyActual', { header: 'Hourly Actual', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('hourlyForecast', { header: 'Hourly Forecast', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('hourlyPct', { header: 'Hourly %', cell: (i) => pct(i.getValue()) }),
    fcCol.accessor('managerActual', { header: 'Manager Actual', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('managerForecast', { header: 'Manager Forecast', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('managerPct', { header: 'Manager %', cell: (i) => pct(i.getValue()) }),
    fcCol.accessor('totalActual', { header: 'Total Actual', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('totalForecast', { header: 'Total Forecast', cell: (i) => fmtNum(i.getValue()) }),
    fcCol.accessor('totalPct', { header: 'Total %', cell: (i) => pct(i.getValue()) }),
  ], [fcCol])
  const { table: forecastTable, globalFilter: forecastGlobalFilter, setGlobalFilter: setForecastGlobalFilter } =
    useTable(forecastCompareRows, forecastColumns, { persistKey: 'staffing-forecast-compare' })

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  const filtersBar = (
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
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Staffing Report</h1>
        <p className="text-xs text-inky mt-0.5">
          Compares staff clocked-in hours/headcount against Droptop order volume and revenue. Populated by Config →
          Data Connections' Droptop — Staff Time Clock sync.
        </p>
      </div>

      {filtersBar}

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {loading ? (
        <LoadingProgress
          fraction={loadProgress.total ? loadProgress.loaded / loadProgress.total : null}
          countText={
            loadProgress.total
              ? `Loading staffing data — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
              : loadProgress.loaded > 0
                ? `Loading staffing data — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                : 'Loading staffing data…'
          }
          messages={['Pulling clock-in/clock-out records…', 'Pulling order counts…', 'Matching by shop and day…']}
        />
      ) : (
        <Tabs defaultValue="summary">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="rollup">Rollup</TabsTrigger>
            <TabsTrigger value="labor-config">Labor Config</TabsTrigger>
          </TabsList>

          <TabsContent value="summary">
            <div className="flex flex-col gap-4">
              <div className="flex gap-3 flex-wrap">
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Orders (Effective Cars)</p>
                  <p className="text-lg font-heading font-bold text-navy">{fmtNum(summary.totalOrders, 0)}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Labor Hours</p>
                  <p className="text-lg font-heading font-bold text-navy">{fmtNum(summary.totalHours)}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Labor $</p>
                  <p className="text-lg font-heading font-bold text-navy">{money(summary.laborDollars)}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Labor % of Revenue</p>
                  <p className="text-lg font-heading font-bold text-navy">{summary.laborPctOfRevenue != null ? `${fmtNum(summary.laborPctOfRevenue, 1)}%` : '—'}</p>
                </CardBody></Card>
                <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide flex items-center gap-1">LHCE <InfoTooltip text="Labor Hours / (Effective) Car" /></p>
                  <p className="text-lg font-heading font-bold text-navy">{fmtNum(summary.lhce)}</p>
                </CardBody></Card>
              </div>

              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">By Day of Week</span></CardHeader>
                <CardBody>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    {dayOfWeekBreakdown.map((d) => (
                      <div key={d.name} className="rounded border border-navy/20 px-2 py-2 text-center flex flex-col gap-1.5">
                        <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{d.name} ({d.count})</p>
                        <div>
                          <p className="text-sm font-heading font-bold text-navy">{fmtNum(d.totalHours, 1)}</p>
                          <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">
                            Hours{d.count > 1 && d.avgHoursPerDay != null ? ` (avg ${fmtNum(d.avgHoursPerDay, 1)}/day)` : ''}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm font-heading font-bold text-navy">{d.laborPctOfRevenue != null ? `${fmtNum(d.laborPctOfRevenue, 1)}%` : '—'}</p>
                          <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">Labor % Rev</p>
                        </div>
                        <div>
                          <p className="text-sm font-heading font-bold text-navy">{fmtNum(d.lhce)}</p>
                          <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">LHCE</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] font-mono text-inky/50 mt-2">
                    "({'{'}count{'}'})" is how many of that weekday fall within the selected period (e.g. "Friday (3)" = 3 Fridays).
                  </p>
                </CardBody>
              </Card>

              <div>
                <h2 className="text-xs font-mono text-navy uppercase tracking-wide mb-2">Rollup</h2>
                <RollupTable rows={shopRollups} timecardsFor={timecardsFor} exportFilenameBase={`staffing-summary-rollup-${range.start}-to-${range.end}`} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="rollup">
            <RollupTable rows={shopRollups} timecardsFor={timecardsFor} exportFilenameBase={`staffing-rollup-${range.start}-to-${range.end}`} />
          </TabsContent>

          {/* Labor Config — hosts the Labor Hour Forecast upload + the
              wage-threshold proxy setting. A Staffing List upload (a real
              employee -> Manager/Hourly roster, to replace the wage-
              threshold proxy below with an actual classification for
              anyone on it) is planned for this same tab but not built yet
              — flagged as a follow-up, not stubbed here. */}
          <TabsContent value="labor-config">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Manager Wage Threshold</span></CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <p className="text-[11px] font-mono text-inky/60">
                    Droptop's time clock has no role/title field, so there's no direct way to tell a shop manager
                    apart from an hourly employee. This is a proxy: anyone clocked in at or above this hourly wage
                    counts as a manager for the Actual-vs-Forecast split below. Adjust it to match your actual pay
                    bands — it applies company-wide.
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">$/hr and above = Manager</span>
                    <Input type="number" value={thresholdDraft} onChange={(e) => setThresholdDraft(e.target.value)}
                      onBlur={() => { const v = Number(thresholdDraft); if (v > 0) setManagerWageThreshold(v) }}
                      className="w-24" />
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Upload Labor Hour Forecast</span></CardHeader>
                <CardBody className="flex flex-col gap-3">
                  <p className="text-[11px] font-mono text-inky/60">
                    One row per shop per date. Expected columns (header names are matched loosely, case-insensitive):
                    <strong> Shop</strong> (number or name), <strong>Date</strong>, <strong>Hourly Hours</strong> and/or
                    <strong> Manager Hours</strong> (at least one required). Re-uploading the same shop/date updates
                    that row rather than duplicating it.
                  </p>
                  <FileUploadZone onParsed={(result) => handleParsed(result)} />
                </CardBody>
              </Card>

              {uploadPreview && (() => {
                const matched = uploadPreview.filter((r) => r.locationId && r.date)
                const unmatched = uploadPreview.filter((r) => !r.locationId || !r.date)
                const PREVIEW_LIMIT = 30
                return (
                  <Card>
                    <CardHeader>
                      <span className="text-xs font-mono text-navy uppercase tracking-wide">
                        Review Import — {matched.length} row(s) ready{unmatched.length ? `, ${unmatched.length} skipped` : ''}
                      </span>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                      <div className="overflow-auto rounded border border-navy/30 max-h-72">
                        <table className="w-full text-xs font-mono">
                          <thead className="sticky top-0 bg-cream">
                            <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                              <th className="px-2 py-1.5 text-left">Shop (as uploaded)</th>
                              <th className="px-2 py-1.5 text-left">Matched Shop</th>
                              <th className="px-2 py-1.5 text-left">Date</th>
                              <th className="px-2 py-1.5 text-right">Hourly Hrs</th>
                              <th className="px-2 py-1.5 text-right">Manager Hrs</th>
                            </tr>
                          </thead>
                          <tbody>
                            {uploadPreview.slice(0, PREVIEW_LIMIT).map((r, i) => (
                              <tr key={i} className={[i % 2 ? 'bg-navy/[0.02]' : '', !r.locationId || !r.date ? 'text-[#C0392B]' : ''].join(' ')}>
                                <td className="px-2 py-1">{r.shopRaw}</td>
                                <td className="px-2 py-1">{r.locationId ? loc.labelOf(r.locationId) : 'No match'}</td>
                                <td className="px-2 py-1">{r.date ?? 'Unparseable'}</td>
                                <td className="px-2 py-1 text-right">{fmtNum(r.hourlyHours)}</td>
                                <td className="px-2 py-1 text-right">{fmtNum(r.managerHours)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {uploadPreview.length > PREVIEW_LIMIT && (
                        <p className="text-[11px] font-mono text-inky/60">Showing first {PREVIEW_LIMIT} of {uploadPreview.length} rows.</p>
                      )}
                      <div className="flex items-center gap-2">
                        <Button size="sm" loading={importing} disabled={!matched.length} onClick={confirmImport}>
                          Confirm Import ({matched.length})
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setUploadPreview(null)}>Cancel</Button>
                      </div>
                    </CardBody>
                  </Card>
                )
              })()}

              {forecastError && (
                <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{forecastError}</p>
              )}

              {forecastLoading ? (
                <LoadingProgress fraction={null} countText="Loading forecast data…" messages={['Pulling forecast rows…']} />
              ) : forecastCompareRows.length === 0 ? (
                <Card><CardBody>
                  <p className="text-xs font-mono text-inky/60">
                    No forecast data for this period/filter yet — upload a file above to get started.
                  </p>
                </CardBody></Card>
              ) : (
                <>
                  <div className="flex gap-3 flex-wrap">
                    <Card className="flex-1 min-w-[160px]"><CardBody className="py-3">
                      <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Hourly: Actual / Forecast</p>
                      <p className="text-sm font-heading font-bold text-navy">
                        {fmtNum(forecastTotals.hourlyActual, 1)} / {fmtNum(forecastTotals.hourlyForecast, 1)}
                        {forecastTotals.hourlyForecast > 0 && ` (${fmtNum((forecastTotals.hourlyActual / forecastTotals.hourlyForecast) * 100, 0)}%)`}
                      </p>
                    </CardBody></Card>
                    <Card className="flex-1 min-w-[160px]"><CardBody className="py-3">
                      <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Manager: Actual / Forecast</p>
                      <p className="text-sm font-heading font-bold text-navy">
                        {fmtNum(forecastTotals.managerActual, 1)} / {fmtNum(forecastTotals.managerForecast, 1)}
                        {forecastTotals.managerForecast > 0 && ` (${fmtNum((forecastTotals.managerActual / forecastTotals.managerForecast) * 100, 0)}%)`}
                      </p>
                    </CardBody></Card>
                    <Card className="flex-1 min-w-[160px]"><CardBody className="py-3">
                      <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total: Actual / Forecast</p>
                      <p className="text-sm font-heading font-bold text-navy">
                        {fmtNum(forecastTotals.totalActual, 1)} / {fmtNum(forecastTotals.totalForecast, 1)}
                        {forecastTotals.totalForecast > 0 && ` (${fmtNum((forecastTotals.totalActual / forecastTotals.totalForecast) * 100, 0)}%)`}
                      </p>
                    </CardBody></Card>
                  </div>
                  <DataTable
                    table={forecastTable}
                    globalFilter={forecastGlobalFilter}
                    onGlobalFilterChange={setForecastGlobalFilter}
                    exportFilename={`labor-hour-forecast-${range.start}-to-${range.end}`}
                  />
                </>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
