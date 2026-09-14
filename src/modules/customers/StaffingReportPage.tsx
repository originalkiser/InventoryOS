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
  Card, CardHeader, CardBody, MultiSelectDropdown, Tabs, TabsList, TabsTrigger, TabsContent, Button, Input, Toggle, Modal,
} from '@/components/ui'
import { isM5, type Classification } from './PackageMappingPage'

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

interface OrderRow {
  id: string; location_id: string | null; order_finalized_at: string | null; final_price: string | number | null; status: string | null
  email: string | null; coupons: unknown; discounts: unknown
}
// A very rough "does this look like a real email" check — Droptop doesn't
// verify addresses, so this is a heuristic for "Good Email %", not a real
// validator (a typo'd but shaped-like-an-email string still passes).
function looksLikeEmail(email: string | null): boolean {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}
function hasDiscountOrCoupon(o: Pick<OrderRow, 'coupons' | 'discounts'>): boolean {
  return (Array.isArray(o.coupons) && o.coupons.length > 0) || (Array.isArray(o.discounts) && o.discounts.length > 0)
}

// M5 sub-categories, each individually toggleable on the By Day of Week
// cards (see DOW_KPI_OPTIONS below) — 'm5' itself is the combined
// percentage across all 5. Only meaningful once package-line-item data is
// loaded, which (see loadShopPackages below) only happens when the current
// filter resolves to exactly one shop.
const M5_SUBTYPES = ['air_filter', 'cabin_air_filter', 'wiper_blades', 'additives', 'tire_rotation'] as const
type M5Subtype = typeof M5_SUBTYPES[number]
const M5_SUBTYPE_LABELS: Record<M5Subtype, string> = {
  air_filter: 'Air Filter %', cabin_air_filter: 'Cabin Filter %', wiper_blades: 'Wipers %',
  additives: 'Additives %', tire_rotation: 'Tire Rotation %',
}
interface M5Counts { oilChange: number; m5: number; bySubtype: Record<M5Subtype, number> }
function emptyM5Counts(): M5Counts {
  return { oilChange: 0, m5: 0, bySubtype: { air_filter: 0, cabin_air_filter: 0, wiper_blades: 0, additives: 0, tire_rotation: 0 } }
}
function m5Pct(counts: M5Counts, key: 'm5' | M5Subtype): number | null {
  return counts.oilChange > 0 ? round2(((key === 'm5' ? counts.m5 : counts.bySubtype[key]) / counts.oilChange) * 100) : null
}

// Which By-Day-of-Week KPI cards are available to show — the original 4
// (hours/avgPerDay/laborPctRevenue/lhce) plus M5% and its 5 sub-categories.
// Company-wide setting (Labor Config -> "Day of Week KPIs"), so every user
// sees the same cards; defaults to exactly the original 4 so nobody's view
// changes until an admin opts into more.
const DOW_KPI_OPTIONS: { key: string; label: string }[] = [
  { key: 'hours', label: 'Total / Avg Hours' },
  { key: 'labor_pct_revenue', label: 'Labor % of Revenue' },
  { key: 'lhce', label: 'LHCE' },
  { key: 'm5', label: 'M5 % (combined)' },
  ...M5_SUBTYPES.map((s) => ({ key: s, label: M5_SUBTYPE_LABELS[s] })),
]
const DEFAULT_DOW_KPIS = ['hours', 'labor_pct_revenue', 'lhce']

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

const KPI_OPTIONS = [
  { value: 'lhce', label: 'LHCE' },
  { value: 'labor_pct_revenue', label: 'Labor % of Revenue' },
  { value: 'daily_hours_employee', label: 'Daily Hours by Employee' },
  { value: 'weekly_hours_employee', label: 'Weekly Hours by Employee' },
  { value: 'daily_hours_shop', label: 'Daily Hours by Shop' },
  { value: 'weekly_hours_shop', label: 'Weekly Hours by Shop' },
]
const OPERATOR_OPTIONS: { value: 'gt' | 'lt' | 'between'; label: string }[] = [
  { value: 'gt', label: 'Greater Than' },
  { value: 'lt', label: 'Less Than' },
  { value: 'between', label: 'Between' },
]

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
interface RowViolation { kpi: string; periodStart: string }
function RollupTable({
  rows, timecardsFor, exportFilenameBase, violationsByLocation,
}: {
  rows: ShopRollupRow[]
  timecardsFor: (locationId: string, date: string) => TimeRecordRow[]
  exportFilenameBase: string
  // Conditional formatting from the Alerts tab — a shop with ANY current
  // violation for a KPI gets that column tinted at the shop-total level;
  // a day row is additionally tinted only when a daily-grain violation's
  // own period_start matches that exact date (weekly/LHCE checks are
  // single-day-equivalent — yesterday — so they naturally line up with at
  // most one day row too, via the same period_start match).
  violationsByLocation?: Map<string, RowViolation[]>
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
              const shopViolations = violationsByLocation?.get(shop.locationId) ?? []
              const hoursFlagged = shopViolations.some((v) => v.kpi === 'daily_hours_shop' || v.kpi === 'weekly_hours_shop')
              const lhceFlagged = shopViolations.some((v) => v.kpi === 'lhce')
              const alertCellCls = 'bg-[#C0392B]/10 text-[#C0392B] font-bold'
              return (
                <Fragment key={shop.locationId}>
                  <tr onClick={() => toggleShop(shop.locationId)} className="border-b border-navy/10 hover:bg-sky/10 cursor-pointer">
                    <td className="px-3 py-2 text-navy font-bold flex items-center gap-1.5">
                      <Chevron open={shopOpen} /> {shop.shopLabel}
                    </td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.staffCount, 0)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${hoursFlagged ? alertCellCls : 'text-navy'}`}>{fmtNum(shop.totalHours)}</td>
                    <td className="px-3 py-2 text-right text-navy tabular-nums">{fmtNum(shop.totalOrders, 0)}</td>
                    <td className={`px-3 py-2 text-right tabular-nums ${lhceFlagged ? alertCellCls : 'text-navy'}`}>{fmtNum(shop.lhce)}</td>
                  </tr>
                  {shopOpen && shop.days.map((day) => {
                    const dayKey = `${shop.locationId}|${day.date}`
                    const dayOpen = expandedDays.has(dayKey)
                    const dayHoursFlagged = shopViolations.some((v) => v.kpi === 'daily_hours_shop' && v.periodStart === day.date)
                    const dayLhceFlagged = shopViolations.some((v) => v.kpi === 'lhce' && v.periodStart === day.date)
                    return (
                      <Fragment key={dayKey}>
                        <tr onClick={() => toggleDay(dayKey)} className="border-b border-navy/10 bg-navy/[0.02] hover:bg-sky/10 cursor-pointer">
                          <td className="pl-8 pr-3 py-1.5 text-inky flex items-center gap-1.5">
                            <Chevron open={dayOpen} /> {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.staffCount, 0)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${dayHoursFlagged ? alertCellCls : 'text-inky'}`}>{fmtNum(day.hours)}</td>
                          <td className="px-3 py-1.5 text-right text-inky tabular-nums">{fmtNum(day.orders, 0)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums ${dayLhceFlagged ? alertCellCls : 'text-inky'}`}>{fmtNum(day.lhce)}</td>
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

  // Staffing List roster — a real employee -> Manager/Hourly mapping,
  // takes priority over the wage-threshold proxy above for anyone on it.
  // Keyed by droptop_user_id, not name (names alone can collide across
  // ~250 shops' worth of staff).
  const [roster, setRoster] = useState<Map<string, 'manager' | 'hourly'>>(new Map())
  const loadRoster = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('droptop_staffing_roster')
      .select('droptop_user_id, role').eq('company_id', companyId)
    setRoster(new Map((data ?? []).map((r: { droptop_user_id: string; role: 'manager' | 'hourly' }) => [r.droptop_user_id, r.role])))
  }, [companyId])
  useEffect(() => { loadRoster() }, [loadRoster])
  function roleFor(t: Pick<TimeRecordRow, 'droptop_user_id' | 'hourly_wage'>): 'manager' | 'hourly' {
    return roster.get(t.droptop_user_id) ?? (numWage(t) >= managerWageThreshold ? 'manager' : 'hourly')
  }

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
          .select('id, location_id, order_finalized_at, final_price, status, email, coupons, discounts')
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

  // ---- M5% by day of week (single-shop only) -----------------------------
  // "Shop when manager works" / "shop when manager is off" is inherently a
  // per-shop question (which manager, which days off, varies shop to shop —
  // there's no single "the manager's days off" for a group of shops), so
  // package-line-item data (needed for M5%) is only fetched once the
  // current filter narrows to exactly one location — never company/region/
  // market-wide, which would also mean pulling package rows for potentially
  // hundreds of shops' worth of orders just for a day-of-week card.
  const singleShopId = allowedLocationIds && allowedLocationIds.size === 1 ? [...allowedLocationIds][0] : null
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

  const [shopPackagesByOrder, setShopPackagesByOrder] = useState<Map<string, { name: string | null }[]>>(new Map())
  const [shopPackagesLoading, setShopPackagesLoading] = useState(false)
  useEffect(() => {
    if (!singleShopId) { setShopPackagesByOrder(new Map()); return }
    let cancelled = false
    const orderIds = filteredOrdersFinalized.filter((o) => o.location_id === singleShopId).map((o) => o.id)
    if (!orderIds.length) { setShopPackagesByOrder(new Map()); return }
    setShopPackagesLoading(true)
    const sb = supabase as any
    const CHUNK = 300
    async function run() {
      const byOrder = new Map<string, { name: string | null }[]>()
      for (let i = 0; i < orderIds.length; i += CHUNK) {
        const slice = orderIds.slice(i, i + CHUNK)
        const rows = await fetchAllPages<{ order_id: string; name: string | null }>((from) => sb
          .schema('inventory').from('droptop_order_packages')
          .select('order_id, name').in('order_id', slice).range(from, from + PAGE - 1))
        for (const r of rows) {
          const list = byOrder.get(r.order_id) ?? []
          list.push({ name: r.name })
          byOrder.set(r.order_id, list)
        }
      }
      if (!cancelled) { setShopPackagesByOrder(byOrder); setShopPackagesLoading(false) }
    }
    run().catch(() => { if (!cancelled) setShopPackagesLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleShopId, filteredOrdersFinalized])

  function m5CountsForOrder(orderId: string): M5Counts {
    const counts = emptyM5Counts()
    for (const p of shopPackagesByOrder.get(orderId) ?? []) {
      if (!p.name) continue
      const c = packageClassification.get(p.name)
      if (!c) continue
      if (c === 'oil_change') counts.oilChange++
      else if (isM5(c)) { counts.m5++; counts.bySubtype[c as M5Subtype]++ }
    }
    return counts
  }

  // Which shop-dates (YYYY-MM-DD) a manager (roster-or-wage-threshold, same
  // roleFor() as everywhere else on this page) clocked in at all — the
  // "manager works that day" / "manager off" split reads this, scoped to
  // singleShopId same as the package data above.
  const managerDaysForShop = useMemo(() => {
    const days = new Set<string>()
    if (!singleShopId) return days
    for (const t of filteredTimeRecords) {
      if (t.location_id !== singleShopId) continue
      if (roleFor(t) === 'manager') days.add(t.clock_in.slice(0, 10))
    }
    return days
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredTimeRecords, singleShopId, roster, managerWageThreshold])

  const m5ByWeekday = useMemo(() => {
    if (!singleShopId) return null
    const totalByDow = new Array(7).fill(null).map(() => emptyM5Counts())
    const managerByDow = new Array(7).fill(null).map(() => emptyM5Counts())
    const offByDow = new Array(7).fill(null).map(() => emptyM5Counts())
    for (const o of filteredOrdersFinalized) {
      if (o.location_id !== singleShopId || !o.order_finalized_at) continue
      const dateStr = o.order_finalized_at.slice(0, 10)
      const dow = new Date(`${dateStr}T00:00:00`).getDay()
      const c = m5CountsForOrder(o.id)
      const add = (target: M5Counts) => {
        target.oilChange += c.oilChange
        target.m5 += c.m5
        for (const s of M5_SUBTYPES) target.bySubtype[s] += c.bySubtype[s]
      }
      add(totalByDow[dow])
      add(managerDaysForShop.has(dateStr) ? managerByDow[dow] : offByDow[dow])
    }
    return WEEKDAY_ORDER.map((dowIndex, i) => ({
      name: WEEKDAY_NAMES[i],
      total: totalByDow[dowIndex],
      manager: managerByDow[dowIndex],
      off: offByDow[dowIndex],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleShopId, filteredOrdersFinalized, shopPackagesByOrder, packageClassification, managerDaysForShop])

  // ---- Manager Performance tab -------------------------------------------
  // Company-wide (every shop in the current filter), unlike M5% by weekday
  // above — only metrics computable from data ALREADY loaded for the page
  // (orders + time records) are included here, specifically to avoid a
  // separate heavy per-shop package/vehicle fetch multiplied across
  // potentially hundreds of shops. M5%/HM Capture% (which need package and
  // vehicle-mileage data respectively) are listed as placeholders below,
  // not computed here, for that reason — see the Placeholder Metrics
  // checklist card on this tab.
  const MGR_PERF_METRICS = [
    { key: 'ticketAvg', label: 'Ticket Avg', higherIsBetter: true, fmt: (v: number) => money(v) },
    { key: 'carsPerDay', label: 'Cars per Day', higherIsBetter: true, fmt: (v: number) => fmtNum(v, 1) },
    { key: 'laborPctRevenue', label: 'Labor % of Revenue', higherIsBetter: false, fmt: (v: number) => `${fmtNum(v, 1)}%` },
    { key: 'lhce', label: 'LHCE', higherIsBetter: false, fmt: (v: number) => fmtNum(v) },
    { key: 'goodEmailPct', label: 'Good Email %', higherIsBetter: true, fmt: (v: number) => `${fmtNum(v, 1)}%` },
    { key: 'discountPct', label: 'Discount %', higherIsBetter: false, fmt: (v: number) => `${fmtNum(v, 1)}%` },
  ] as const
  type MgrPerfKey = typeof MGR_PERF_METRICS[number]['key']
  type MgrPerfMetrics = Record<MgrPerfKey, number | null>

  interface ManagerPerfBucket { orders: number; revenue: number; hours: number; laborDollars: number; emailCount: number; discountCount: number }
  function emptyMgrPerfBucket(): ManagerPerfBucket { return { orders: 0, revenue: 0, hours: 0, laborDollars: 0, emailCount: 0, discountCount: 0 } }

  const managerPerfRows = useMemo(() => {
    // Which shop-dates a manager clocked in at all — same roleFor() as
    // everywhere else on this page, just company-wide instead of one shop.
    const managerDaysByShop = new Map<string, Set<string>>()
    for (const t of filteredTimeRecords) {
      if (!t.location_id || roleFor(t) !== 'manager') continue
      const set = managerDaysByShop.get(t.location_id) ?? new Set<string>()
      set.add(t.clock_in.slice(0, 10))
      managerDaysByShop.set(t.location_id, set)
    }
    const observedDaysByShop = new Map<string, Set<string>>()
    function markObserved(shop: string, date: string) {
      const set = observedDaysByShop.get(shop) ?? new Set<string>()
      set.add(date)
      observedDaysByShop.set(shop, set)
    }

    const withBuckets = new Map<string, ManagerPerfBucket>()
    const withoutBuckets = new Map<string, ManagerPerfBucket>()
    function addTo(map: Map<string, ManagerPerfBucket>, shop: string): ManagerPerfBucket {
      const b = map.get(shop) ?? emptyMgrPerfBucket()
      map.set(shop, b)
      return b
    }

    for (const o of filteredOrdersFinalized) {
      if (!o.location_id || !o.order_finalized_at) continue
      const date = o.order_finalized_at.slice(0, 10)
      markObserved(o.location_id, date)
      const isManagerDay = managerDaysByShop.get(o.location_id)?.has(date) ?? false
      const b = addTo(isManagerDay ? withBuckets : withoutBuckets, o.location_id)
      b.orders++
      b.revenue += Number(o.final_price) || 0
      if (looksLikeEmail(o.email)) b.emailCount++
      if (hasDiscountOrCoupon(o)) b.discountCount++
    }
    for (const t of filteredTimeRecords) {
      if (!t.location_id) continue
      const date = t.clock_in.slice(0, 10)
      markObserved(t.location_id, date)
      const isManagerDay = managerDaysByShop.get(t.location_id)?.has(date) ?? false
      const b = addTo(isManagerDay ? withBuckets : withoutBuckets, t.location_id)
      b.hours += numHours(t)
      b.laborDollars += numHours(t) * numWage(t)
    }

    function metricsFor(b: ManagerPerfBucket, days: number): MgrPerfMetrics {
      return {
        ticketAvg: b.orders > 0 ? round2(b.revenue / b.orders) : null,
        carsPerDay: days > 0 ? round2(b.orders / days) : null,
        laborPctRevenue: b.revenue > 0 ? round2((b.laborDollars / b.revenue) * 100) : null,
        lhce: b.orders > 0 ? round2(b.hours / b.orders) : null,
        goodEmailPct: b.orders > 0 ? round2((b.emailCount / b.orders) * 100) : null,
        discountPct: b.orders > 0 ? round2((b.discountCount / b.orders) * 100) : null,
      }
    }

    const allShopIds = new Set([...withBuckets.keys(), ...withoutBuckets.keys()])
    return [...allShopIds].map((locationId) => {
      const withDays = managerDaysByShop.get(locationId)?.size ?? 0
      const observedDays = observedDaysByShop.get(locationId)?.size ?? 0
      const withoutDays = Math.max(0, observedDays - withDays)
      return {
        locationId,
        shopLabel: loc.labelOf(locationId),
        withDays,
        withoutDays,
        with: metricsFor(withBuckets.get(locationId) ?? emptyMgrPerfBucket(), withDays),
        without: metricsFor(withoutBuckets.get(locationId) ?? emptyMgrPerfBucket(), withoutDays),
      }
    }).sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredOrdersFinalized, filteredTimeRecords, roster, managerWageThreshold, loc.labelOf])

  // Placeholder metrics from the target sheet with no real data source yet
  // in SB Net today, kept visible (not silently dropped) so it's clear
  // what's still needed rather than looking like an oversight.
  const MGR_PERF_PLACEHOLDERS: { label: string; needs: string }[] = [
    { label: '% of Net Sales', needs: 'A defined sales allocation/plan basis — not tracked anywhere in SB Net today.' },
    { label: 'Net Sales Plan Var.', needs: 'A sales PLAN/budget figure per shop per period — no budgeting module exists yet.' },
    { label: 'Net Sales PY Var.', needs: 'Reliable prior-year Droptop order history for the same period — technically possible once historical backfill coverage is confirmed solid; not attempted here given the sync-gap issues fixed this week.' },
    { label: 'Cars per Day - Plan Var.', needs: 'A planned cars/day figure per shop — no planning module exists yet.' },
    { label: 'M5 % (+ 5 sub-categories)', needs: 'Buildable (Package Mapping classification already exists) but needs a per-shop package-line-item fetch — company-wide across every shop in the filter would be a much larger fetch than this tab\'s other metrics. Flagging as a follow-up rather than fetching it eagerly here.' },
    { label: 'R&P Total %', needs: 'Unclear what "R&P" refers to in Droptop\'s own data — needs a definition before this can be built.' },
    { label: 'HM Capture %', needs: 'Buildable — vehicle mileage data is solid (696k+ of 696.7k vehicles have it) — needs a mileage threshold decision (e.g. 75k mi) and a per-shop vehicle+package fetch, same fetch-size concern as M5% above.' },
    { label: 'NPS %', needs: 'No customer survey/NPS system feeds SB Net.' },
    { label: 'Mgr Discount %', needs: 'Droptop\'s discount/coupon data has no field indicating WHO applied a discount or whether it was manager-authorized (checked the real payload shape) — only Discount % (any discount/coupon) is derivable, shown above.' },
    { label: 'Insp. per Day / Insp. Conv. %', needs: 'No inspection-tracking system feeds SB Net.' },
  ]

  // Company-wide toggle (Labor Config -> Day of Week KPIs) controlling which
  // cards render in the By Day of Week section below — defaults to exactly
  // the original 4 metrics so nobody's view changes unless an admin opts in.
  const [dowKpis, setDowKpis] = useAppSetting<string[]>('staffing_dow_kpis', DEFAULT_DOW_KPIS)
  const showDowKpi = (key: string) => dowKpis.includes(key)

  // ---- Manager Labor tab --------------------------------------------------
  // Fixed trailing 7 FULL days ending yesterday (never today — a shift
  // still in progress would read as artificially low hours), independent
  // of whatever period the rest of the page has selected — the user asked
  // for "last 7 days," not "last 7 days of the selected period." Fetched
  // separately from the main range-based load above for the same reason.
  const managerLaborRange = useMemo(() => {
    const end = new Date(); end.setUTCHours(0, 0, 0, 0); end.setUTCDate(end.getUTCDate() - 1)
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6)
    const days: string[] = []
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10))
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days }
  }, [])
  function dayColumnLabel(dateStr: string): string {
    const [, m, d] = dateStr.split('-')
    const wd = new Date(`${dateStr}T12:00:00Z`).getUTCDay()
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd]} ${m}/${d}`
  }

  const [managerLaborRecords, setManagerLaborRecords] = useState<TimeRecordRow[]>([])
  const [managerLaborLoading, setManagerLaborLoading] = useState(true)
  const [managerLaborError, setManagerLaborError] = useState<string | null>(null)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setManagerLaborLoading(true)
    setManagerLaborError(null)
    const sb = supabase as any
    const startIso = `${managerLaborRange.start}T00:00:00.000Z`
    const endIso = `${managerLaborRange.end}T23:59:59.999Z`
    fetchAllPages<TimeRecordRow>((from) => sb.schema('inventory').from('droptop_time_records')
      .select('location_id, droptop_user_id, first_name, last_name, clock_in, clock_out, hours, hourly_wage')
      .eq('company_id', companyId).gte('clock_in', startIso).lte('clock_in', endIso)
      .order('clock_in', { ascending: true }).range(from, from + PAGE - 1))
      .then((rows) => { if (!cancelled) { setManagerLaborRecords(rows); setManagerLaborLoading(false) } })
      .catch((e) => { if (!cancelled) { setManagerLaborError(e instanceof Error ? e.message : 'Failed to load manager labor data'); setManagerLaborLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, managerLaborRange.start, managerLaborRange.end])

  // Filterable the same way as the rest of the page — reuses allowedLocationIds
  // (Region/Market/AM/Shop bar above, shared across every tab).
  const managerLaborFiltered = useMemo(
    () => allowedLocationIds ? managerLaborRecords.filter((t) => allowedLocationIds.has(t.location_id)) : managerLaborRecords,
    [managerLaborRecords, allowedLocationIds],
  )

  interface ManagerLaborRow { locationId: string; shopLabel: string; hoursByDay: Record<string, number> }
  const managerLaborRows = useMemo((): ManagerLaborRow[] => {
    const byShop = new Map<string, Record<string, number>>()
    for (const t of managerLaborFiltered) {
      if (roleFor(t) !== 'manager') continue
      const date = t.clock_in.slice(0, 10)
      if (!managerLaborRange.days.includes(date)) continue
      const rec = byShop.get(t.location_id) ?? Object.fromEntries(managerLaborRange.days.map((d) => [d, 0]))
      rec[date] = (rec[date] ?? 0) + numHours(t)
      byShop.set(t.location_id, rec)
    }
    return [...byShop.entries()]
      .map(([locationId, hoursByDay]) => ({
        locationId, shopLabel: loc.labelOf(locationId),
        hoursByDay: Object.fromEntries(Object.entries(hoursByDay).map(([d, h]) => [d, round2(h)])),
      }))
      .sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerLaborFiltered, roster, managerWageThreshold, loc.labelOf, managerLaborRange.days])

  // Conditional formatting rules — company-wide (everyone sees the same
  // highlighting), as many as the user wants, each an independent
  // less-than/greater-than threshold + a color the user picks themselves
  // (a data-highlight color the user is deliberately choosing per rule,
  // not new app-chrome, so the brand palette restriction doesn't apply the
  // way it would to a UI element).
  interface CfRule { id: string; operator: 'gt' | 'lt'; threshold: number; color: string }
  const [cfRules, setCfRules] = useAppSetting<CfRule[]>('staffing_manager_labor_cf_rules', [])
  const [cfModalOpen, setCfModalOpen] = useState(false)
  const [newCfOperator, setNewCfOperator] = useState<'gt' | 'lt'>('lt')
  const [newCfThreshold, setNewCfThreshold] = useState('4')
  const [newCfColor, setNewCfColor] = useState('#C0392B')

  function addCfRule() {
    const threshold = Number(newCfThreshold)
    if (!Number.isFinite(threshold)) { toast.error('Enter a valid number for the threshold'); return }
    setCfRules([...cfRules, { id: crypto.randomUUID(), operator: newCfOperator, threshold, color: newCfColor }])
  }
  function removeCfRule(id: string) { setCfRules(cfRules.filter((r) => r.id !== id)) }
  function matchingCfRule(value: number): CfRule | null {
    for (const r of cfRules) {
      if (r.operator === 'gt' && value > r.threshold) return r
      if (r.operator === 'lt' && value < r.threshold) return r
    }
    return null
  }
  function cfCellStyle(value: number): { backgroundColor: string; color: string; fontWeight: number } | undefined {
    const rule = matchingCfRule(value)
    if (!rule) return undefined
    return { backgroundColor: `${rule.color}22`, color: rule.color, fontWeight: 700 }
  }

  // One row per shop (not one row per flagged day) — a shop with 3 flagged
  // days out of the 7 still shows as a single row with those 3 cells
  // highlighted, same columns as the main table above it.
  const flaggedManagerLaborRows = useMemo(
    () => managerLaborRows.filter((r) => managerLaborRange.days.some((d) => matchingCfRule(r.hoursByDay[d] ?? 0))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [managerLaborRows, cfRules, managerLaborRange.days],
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
  // Tall (one row per shop/date) is the original, still-default format; Wide
  // (shops as rows, one column per date) is the "widening out like crazy"
  // alternative some workforce-planning exports use instead. Both funnel
  // into the exact same ParsedForecastRow[]/uploadPreview/confirmImport
  // pipeline below — only the parsing differs.
  const [forecastUploadMode, setForecastUploadMode] = useState<'tall' | 'wide'>('tall')

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

  // Wide/matrix format: first Shop/Location column, every OTHER column
  // header is itself a date (e.g. "9/14/2026") and each cell under it is
  // that shop's forecast hours for that day — "locations in one column and
  // days in the other columns, widening out like crazy" per the original
  // ask, as an alternative to the tall format above for a 30-day forecast
  // that would otherwise be 30×[locationcount] rows tall. A wide file only
  // carries ONE number per (shop, date) — no hourly/manager split — so it
  // lands entirely in hourlyHours, with managerHours left at 0; use the
  // tall format instead if the split matters. A blank cell means "no
  // forecast for that day", not zero, so it's skipped rather than imported
  // as 0 (and won't overwrite an existing value on re-upload).
  function handleWideParsed(result: ParseResult) {
    const shopHeader = findHeader(result.headers, [/shop/i, /location/i])
    if (!shopHeader) {
      toast.error('Could not find a Shop/Location column in this file — it should be the first column.')
      return
    }
    const dateHeaders = result.headers.filter((h) => h !== shopHeader && parseDateSafe(h))
    if (!dateHeaders.length) {
      toast.error('Could not read any of the other column headers as dates — each column after Shop should be a single date, e.g. "9/14/2026".')
      return
    }
    const parsed: ParsedForecastRow[] = []
    for (const row of result.rows) {
      const shopRaw = row[shopHeader] ?? ''
      const locationId = loc.resolveId(shopRaw)
      for (const dateHeader of dateHeaders) {
        const raw = row[dateHeader]
        if (raw == null || raw.trim() === '') continue
        const dateVal = parseDateSafe(dateHeader)
        parsed.push({
          shopRaw,
          locationId,
          date: dateVal ? format(dateVal, 'yyyy-MM-dd') : null,
          hourlyHours: Number(raw) || 0,
          managerHours: 0,
        })
      }
    }
    if (!parsed.length) {
      toast.error('No forecast values found — every cell under the date columns was blank.')
      return
    }
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

  // ---- Staffing List (roster) upload ------------------------------------
  // Every employee who's ever clocked in, with their most recent known
  // name — used to resolve an uploaded "Employee" name to a real
  // droptop_user_id (the upload has no user id, only a name). Loaded once
  // per company, not per filter/date-range change (small: confirmed ~1.5s
  // for ~1,700 distinct employees company-wide via EXPLAIN ANALYZE).
  const [employees, setEmployees] = useState<{ droptopUserId: string; name: string }[]>([])
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.rpc('get_droptop_time_clock_employees').then(({ data }: any) => {
      if (cancelled) return
      setEmployees((data ?? []).map((r: { droptop_user_id: string; first_name: string | null; last_name: string | null }) => ({
        droptopUserId: r.droptop_user_id, name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      })).filter((e: { name: string }) => e.name))
    })
    return () => { cancelled = true }
  }, [companyId])
  // name (lowercased) -> every droptop_user_id with that exact full name —
  // more than one match means the upload's row is genuinely ambiguous
  // (two different employees, possibly at different shops, happen to
  // share a name) and needs a human to resolve it, not a guess.
  const employeesByName = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const e of employees) {
      const key = e.name.trim().toLowerCase()
      const list = m.get(key) ?? []
      list.push(e.droptopUserId)
      m.set(key, list)
    }
    return m
  }, [employees])

  interface ParsedRosterRow {
    nameRaw: string
    droptopUserId: string | null
    matchedName: string | null
    ambiguous: number | null // count of matches, when >1
    role: 'manager' | 'hourly' | null
  }
  const [rosterUploadPreview, setRosterUploadPreview] = useState<ParsedRosterRow[] | null>(null)
  const [importingRoster, setImportingRoster] = useState(false)

  function handleRosterParsed(result: ParseResult) {
    const nameHeader = findHeader(result.headers, [/employee/i, /name/i])
    const roleHeader = findHeader(result.headers, [/role/i])
    if (!nameHeader || !roleHeader) {
      toast.error('Could not find Employee and Role columns in this file — check the headers match what\'s expected above.')
      return
    }
    const parsed: ParsedRosterRow[] = result.rows.map((row) => {
      const nameRaw = (row[nameHeader] ?? '').trim()
      const matches = employeesByName.get(nameRaw.toLowerCase()) ?? []
      const roleRaw = (row[roleHeader] ?? '').trim()
      const role: 'manager' | 'hourly' | null = /manager|mgr/i.test(roleRaw) ? 'manager' : /hourly|hrly/i.test(roleRaw) ? 'hourly' : null
      return {
        nameRaw,
        droptopUserId: matches.length === 1 ? matches[0] : null,
        matchedName: matches.length === 1 ? nameRaw : null,
        ambiguous: matches.length > 1 ? matches.length : null,
        role,
      }
    })
    setRosterUploadPreview(parsed)
  }

  async function confirmRosterImport() {
    if (!rosterUploadPreview || !companyId) return
    const valid = rosterUploadPreview.filter((r) => r.droptopUserId && r.role)
    if (!valid.length) { toast.error('No rows had both a matched employee and a recognized role — nothing to import'); return }
    setImportingRoster(true)
    try {
      const sb = supabase as any
      const BATCH = 500
      for (let i = 0; i < valid.length; i += BATCH) {
        const slice = valid.slice(i, i + BATCH).map((r) => {
          const emp = employees.find((e) => e.droptopUserId === r.droptopUserId)
          const [firstName, ...rest] = (emp?.name ?? '').split(' ')
          return {
            company_id: companyId, droptop_user_id: r.droptopUserId, first_name: firstName || null,
            last_name: rest.join(' ') || null, role: r.role, updated_by: profile?.id ?? null, updated_at: new Date().toISOString(),
          }
        })
        const { error } = await sb.schema('inventory').from('droptop_staffing_roster')
          .upsert(slice, { onConflict: 'company_id,droptop_user_id' })
        if (error) throw new Error(error.message)
      }
      toast.success(`Imported ${valid.length} roster row(s)`)
      setRosterUploadPreview(null)
      loadRoster()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImportingRoster(false)
    }
  }

  const forecastCompareRows = useMemo((): ForecastCompareRow[] => {
    const actualByKey = new Map<string, { hourly: number; manager: number }>()
    for (const t of filteredTimeRecords) {
      const date = t.clock_in.slice(0, 10)
      const key = `${t.location_id}|${date}`
      const e = actualByKey.get(key) ?? { hourly: 0, manager: 0 }
      const h = numHours(t)
      if (roleFor(t) === 'manager') e.manager += h; else e.hourly += h
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
  }, [forecastRows, filteredTimeRecords, allowedLocationIds, loc.labelOf, managerWageThreshold, roster])

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

  // ---- Alerts tab --------------------------------------------------------
  // Evaluated by a scheduled backend job (staffing-alerts-refresh, same
  // Data Connections dispatcher pattern as every other scheduled sync)
  // rather than live in the browser — persists between visits. Run Now
  // below calls the same function interactively (the caller's own
  // session) for an immediate refresh right after adding/editing a rule.
  interface AlertRule {
    id: string; kpi: string; operator: 'gt' | 'lt' | 'between'
    threshold_low: number; threshold_high: number | null
    scope: 'all' | 'selected'; location_ids: string[]; enabled: boolean
  }
  interface AlertViolation {
    id: string; rule_id: string; location_id: string | null; shop_label: string | null
    droptop_user_id: string | null; employee_name: string | null
    period_start: string; period_end: string; actual_value: number | string
    rule_snapshot: { kpi: string; operator: string; threshold_low: number; threshold_high: number | null }
  }
  const [alertRules, setAlertRules] = useState<AlertRule[]>([])
  const [alertViolations, setAlertViolations] = useState<AlertViolation[]>([])
  const [alertsLoading, setAlertsLoading] = useState(true)
  const [runningAlerts, setRunningAlerts] = useState(false)

  const loadAlerts = useCallback(async () => {
    if (!companyId) return
    setAlertsLoading(true)
    const sb = supabase as any
    const [{ data: rules }, { data: viols }] = await Promise.all([
      sb.schema('inventory').from('staffing_alert_rules').select('*').eq('company_id', companyId).order('created_at'),
      sb.schema('inventory').from('staffing_alert_violations').select('*').eq('company_id', companyId).order('detected_at', { ascending: false }),
    ])
    setAlertRules((rules ?? []) as AlertRule[])
    setAlertViolations((viols ?? []) as AlertViolation[])
    setAlertsLoading(false)
  }, [companyId])
  useEffect(() => { loadAlerts() }, [loadAlerts])

  const [newRuleKpi, setNewRuleKpi] = useState('lhce')
  const [newRuleOperator, setNewRuleOperator] = useState<'gt' | 'lt' | 'between'>('gt')
  const [newRuleLow, setNewRuleLow] = useState('')
  const [newRuleHigh, setNewRuleHigh] = useState('')
  const [newRuleScope, setNewRuleScope] = useState<'all' | 'selected'>('all')
  const [newRuleShops, setNewRuleShops] = useState<string[]>([])
  const [savingRule, setSavingRule] = useState(false)

  async function addRule() {
    if (!companyId) return
    const low = Number(newRuleLow)
    if (!Number.isFinite(low)) { toast.error('Enter a threshold value'); return }
    const high = newRuleOperator === 'between' ? Number(newRuleHigh) : null
    if (newRuleOperator === 'between' && !Number.isFinite(high)) { toast.error('Enter both threshold values for "Between"'); return }
    if (newRuleScope === 'selected' && !newRuleShops.length) { toast.error('Select at least one shop, or switch to "All Shops"'); return }
    setSavingRule(true)
    try {
      const sb = supabase as any
      const { error } = await sb.schema('inventory').from('staffing_alert_rules').insert({
        company_id: companyId, kpi: newRuleKpi, operator: newRuleOperator,
        threshold_low: low, threshold_high: high,
        scope: newRuleScope, location_ids: newRuleShops.map((l) => labelToId.get(l)).filter(Boolean),
        created_by: profile?.id ?? null,
      })
      if (error) throw new Error(error.message)
      setNewRuleLow(''); setNewRuleHigh(''); setNewRuleShops([])
      toast.success('Alert rule added')
      loadAlerts()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add rule')
    } finally {
      setSavingRule(false)
    }
  }
  async function deleteRule(id: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('staffing_alert_rules').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Rule removed')
    loadAlerts()
  }
  async function toggleRule(id: string, enabled: boolean) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('staffing_alert_rules').update({ enabled }).eq('id', id)
    if (error) { toast.error(error.message); return }
    loadAlerts()
  }
  async function runAlertsNow() {
    setRunningAlerts(true)
    try {
      const { data, error } = await supabase.functions.invoke('staffing-alerts-refresh', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      toast.success(`Checked ${data.rules_checked} rule(s) — ${data.violations_found} violation(s) found`)
      loadAlerts()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunningAlerts(false)
    }
  }

  function ruleSummary(r: AlertRule): string {
    const kpiLabel = KPI_OPTIONS.find((k) => k.value === r.kpi)?.label ?? r.kpi
    const opLabel = r.operator === 'gt' ? '>' : r.operator === 'lt' ? '<' : `between ${fmtNum(r.threshold_low)} and ${fmtNum(r.threshold_high)}`
    const valuePart = r.operator === 'between' ? '' : ` ${fmtNum(r.threshold_low)}`
    const scopePart = r.scope === 'all' ? 'All Shops' : `${r.location_ids.length} shop(s)`
    return `${kpiLabel} ${opLabel}${valuePart} — ${scopePart}`
  }

  const shopLevelViolations = alertViolations.filter((v) => !v.droptop_user_id)
  const employeeLevelViolations = alertViolations.filter((v) => v.droptop_user_id)
  // Conditional formatting for RollupTable — location_id -> every current
  // shop-level violation for that shop.
  const violationsByLocation = useMemo(() => {
    const m = new Map<string, RowViolation[]>()
    for (const v of shopLevelViolations) {
      if (!v.location_id) continue
      const list = m.get(v.location_id) ?? []
      list.push({ kpi: v.rule_snapshot.kpi, periodStart: v.period_start })
      m.set(v.location_id, list)
    }
    return m
  }, [shopLevelViolations])

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
            <TabsTrigger value="manager-performance">Manager Performance</TabsTrigger>
            <TabsTrigger value="alerts">Alerts{alertViolations.length > 0 ? ` (${alertViolations.length})` : ''}</TabsTrigger>
            <TabsTrigger value="manager-labor">Manager Labor</TabsTrigger>
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
                    {dayOfWeekBreakdown.map((d, i) => {
                      const m5 = m5ByWeekday?.[i]
                      return (
                        <div key={d.name} className="rounded border border-navy/20 px-2 py-2 text-center flex flex-col gap-1.5">
                          <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{d.name} ({d.count})</p>
                          {showDowKpi('hours') && (
                            <div>
                              <p className="text-sm font-heading font-bold text-navy">{fmtNum(d.totalHours, 1)}</p>
                              <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">
                                Hours{d.count > 1 && d.avgHoursPerDay != null ? ` (avg ${fmtNum(d.avgHoursPerDay, 1)}/day)` : ''}
                              </p>
                            </div>
                          )}
                          {showDowKpi('labor_pct_revenue') && (
                            <div>
                              <p className="text-sm font-heading font-bold text-navy">{d.laborPctOfRevenue != null ? `${fmtNum(d.laborPctOfRevenue, 1)}%` : '—'}</p>
                              <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">Labor % Rev</p>
                            </div>
                          )}
                          {showDowKpi('lhce') && (
                            <div>
                              <p className="text-sm font-heading font-bold text-navy">{fmtNum(d.lhce)}</p>
                              <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">LHCE</p>
                            </div>
                          )}
                          {(showDowKpi('m5') || M5_SUBTYPES.some(showDowKpi)) && (
                            m5 ? (
                              <>
                                {showDowKpi('m5') && (
                                  <div>
                                    <p className="text-sm font-heading font-bold text-navy">{m5Pct(m5.total, 'm5') != null ? `${fmtNum(m5Pct(m5.total, 'm5')!, 1)}%` : '—'}</p>
                                    <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">M5 % (shop)</p>
                                    <p className="text-[9px] font-mono text-[#0E7C86]">
                                      Mgr: {m5Pct(m5.manager, 'm5') != null ? `${fmtNum(m5Pct(m5.manager, 'm5')!, 1)}%` : '—'}
                                    </p>
                                    <p className="text-[9px] font-mono text-inky/50">
                                      Off: {m5Pct(m5.off, 'm5') != null ? `${fmtNum(m5Pct(m5.off, 'm5')!, 1)}%` : '—'}
                                    </p>
                                  </div>
                                )}
                                {M5_SUBTYPES.filter(showDowKpi).map((s) => (
                                  <div key={s}>
                                    <p className="text-sm font-heading font-bold text-navy">{m5Pct(m5.total, s) != null ? `${fmtNum(m5Pct(m5.total, s)!, 1)}%` : '—'}</p>
                                    <p className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">{M5_SUBTYPE_LABELS[s]} (shop)</p>
                                    <p className="text-[9px] font-mono text-[#0E7C86]">
                                      Mgr: {m5Pct(m5.manager, s) != null ? `${fmtNum(m5Pct(m5.manager, s)!, 1)}%` : '—'}
                                    </p>
                                    <p className="text-[9px] font-mono text-inky/50">
                                      Off: {m5Pct(m5.off, s) != null ? `${fmtNum(m5Pct(m5.off, s)!, 1)}%` : '—'}
                                    </p>
                                  </div>
                                ))}
                              </>
                            ) : (
                              <p className="text-[9px] font-mono text-inky/40 italic">Select a single shop for M5%</p>
                            )
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <p className="text-[10px] font-mono text-inky/50 mt-2">
                    "({'{'}count{'}'})" is how many of that weekday fall within the selected period (e.g. "Friday (3)" = 3 Fridays).
                    {(showDowKpi('m5') || M5_SUBTYPES.some(showDowKpi)) && ' M5% cards need exactly one shop selected above — the "which days the manager is off" split is inherently shop-specific.'}
                    {shopPackagesLoading && ' Loading package data for M5%…'}
                  </p>
                </CardBody>
              </Card>

              <div>
                <h2 className="text-xs font-mono text-navy uppercase tracking-wide mb-2">Rollup</h2>
                <RollupTable rows={shopRollups} timecardsFor={timecardsFor} exportFilenameBase={`staffing-summary-rollup-${range.start}-to-${range.end}`} violationsByLocation={violationsByLocation} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="rollup">
            <RollupTable rows={shopRollups} timecardsFor={timecardsFor} exportFilenameBase={`staffing-rollup-${range.start}-to-${range.end}`} violationsByLocation={violationsByLocation} />
          </TabsContent>

          <TabsContent value="manager-performance">
            <div className="flex flex-col gap-4">
              <Card>
                <CardBody>
                  <p className="text-xs font-mono text-inky/60">
                    How each shop performs on days a manager clocked in vs. days it ran without one, for the selected
                    period ({range.start} to {range.end}) and filters above. Green = manager-present performed better
                    for that metric, red = worse — a metric with no manager-absent (or no manager-present) days in
                    range for a shop shows "—" rather than a misleading comparison.
                  </p>
                </CardBody>
              </Card>

              {managerPerfRows.length === 0 ? (
                <Card><CardBody><p className="text-xs font-mono text-inky/60">No data for this period/filter yet.</p></CardBody></Card>
              ) : (
                <Card>
                  <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">All Shops ({managerPerfRows.length})</span></CardHeader>
                  <CardBody>
                    <div className="overflow-auto rounded border border-navy/20 max-h-[36rem]">
                      <table className="w-full text-xs font-mono">
                        <thead className="sticky top-0 bg-cream">
                          <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                            <th className="px-3 py-2 text-left" rowSpan={2}>Shop</th>
                            {MGR_PERF_METRICS.map((m) => <th key={m.key} className="px-3 py-1 text-center border-l border-navy/10" colSpan={2}>{m.label}</th>)}
                          </tr>
                          <tr className="border-b border-navy/30 text-inky/60">
                            {MGR_PERF_METRICS.map((m) => (
                              <Fragment key={m.key}>
                                <th className="px-2 py-1 text-right border-l border-navy/10 font-normal">Mgr</th>
                                <th className="px-2 py-1 text-right font-normal">No Mgr</th>
                              </Fragment>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {managerPerfRows.map((r, i) => (
                            <tr key={r.locationId} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                              <td className="px-3 py-1.5 text-navy whitespace-nowrap">
                                {r.shopLabel}
                                <span className="text-inky/40 ml-1">({r.withDays}/{r.withoutDays}d)</span>
                              </td>
                              {MGR_PERF_METRICS.map((m) => {
                                const wVal = r.with[m.key]
                                const woVal = r.without[m.key]
                                const canCompare = wVal != null && woVal != null && wVal !== woVal
                                const withIsBetter = canCompare && (m.higherIsBetter ? wVal! > woVal! : wVal! < woVal!)
                                const cellCls = canCompare
                                  ? (withIsBetter ? 'bg-[#2ECC71]/10 text-[#1E8449] font-bold' : 'bg-[#C0392B]/10 text-[#C0392B] font-bold')
                                  : 'text-navy'
                                return (
                                  <Fragment key={m.key}>
                                    <td className={`px-2 py-1.5 text-right border-l border-navy/10 ${cellCls}`}>{wVal != null ? m.fmt(wVal) : '—'}</td>
                                    <td className="px-2 py-1.5 text-right text-navy">{woVal != null ? m.fmt(woVal) : '—'}</td>
                                  </Fragment>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-[10px] font-mono text-inky/50 mt-2">"(Xd/Yd)" = X manager-present days / Y manager-absent days observed for that shop in this period.</p>
                  </CardBody>
                </Card>
              )}

              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Placeholder Metrics — Not Yet Buildable</span></CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <p className="text-[11px] font-mono text-inky/60">
                    From the target sheet, kept visible so it's clear what's still needed rather than silently missing.
                  </p>
                  {MGR_PERF_PLACEHOLDERS.map((p) => (
                    <div key={p.label} className="flex flex-col gap-0.5 border-b border-navy/10 pb-2 last:border-0 last:pb-0">
                      <span className="text-xs font-mono text-navy font-bold">{p.label}</span>
                      <span className="text-[11px] font-mono text-inky/60">{p.needs}</span>
                    </div>
                  ))}
                </CardBody>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="alerts">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader className="flex items-center justify-between">
                  <span className="text-xs font-mono text-navy uppercase tracking-wide">Add Alert Rule</span>
                  <Button size="sm" variant="secondary" loading={runningAlerts} onClick={runAlertsNow}>Run Now</Button>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                  <p className="text-[11px] font-mono text-inky/60">
                    Checked once a day by a scheduled job (turn it on from Config → Data Connections, connection
                    "Staffing Alerts") — LHCE/Labor % of Revenue/Daily Hours check yesterday; Weekly Hours checks the
                    last full week (Sunday–Saturday). Click Run Now above for an immediate check after adding a rule.
                  </p>
                  <div className="flex items-end gap-2 flex-wrap">
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">KPI</span>
                      <select value={newRuleKpi} onChange={(e) => setNewRuleKpi(e.target.value)} className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy">
                        {KPI_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Condition</span>
                      <select value={newRuleOperator} onChange={(e) => setNewRuleOperator(e.target.value as 'gt' | 'lt' | 'between')} className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy">
                        {OPERATOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{newRuleOperator === 'between' ? 'From' : 'Value'}</span>
                      <Input type="number" value={newRuleLow} onChange={(e) => setNewRuleLow(e.target.value)} className="w-24" />
                    </label>
                    {newRuleOperator === 'between' && (
                      <label className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">To</span>
                        <Input type="number" value={newRuleHigh} onChange={(e) => setNewRuleHigh(e.target.value)} className="w-24" />
                      </label>
                    )}
                    <div className="flex gap-1">
                      {(['all', 'selected'] as const).map((s) => (
                        <button key={s} onClick={() => setNewRuleScope(s)}
                          className={['px-2 py-1.5 rounded border text-xs font-mono transition-colors',
                            newRuleScope === s ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
                          {s === 'all' ? 'All Shops' : 'Selected Shops'}
                        </button>
                      ))}
                    </div>
                    {newRuleScope === 'selected' && (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
                        <MultiSelectDropdown options={shopOptions} selected={newRuleShops} onChange={setNewRuleShops} placeholder="Select shop(s)…" showAllOption={false} searchable countNoun="shops" />
                      </div>
                    )}
                    <Button size="sm" loading={savingRule} onClick={addRule}>Add Rule</Button>
                  </div>
                </CardBody>
              </Card>

              {alertRules.length > 0 && (
                <Card>
                  <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Rules ({alertRules.length})</span></CardHeader>
                  <CardBody className="flex flex-col gap-2">
                    {alertRules.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 border-b border-navy/10 pb-2 last:border-0 last:pb-0">
                        <div className="flex items-center gap-2">
                          <Toggle checked={r.enabled} onChange={(v) => toggleRule(r.id, v)} size="sm" color="green" />
                          <span className="text-xs font-mono text-navy">{ruleSummary(r)}</span>
                        </div>
                        <button onClick={() => deleteRule(r.id)} className="text-[11px] font-mono text-[#C0392B] hover:underline">Remove</button>
                      </div>
                    ))}
                  </CardBody>
                </Card>
              )}

              {alertsLoading ? (
                <LoadingProgress fraction={null} countText="Loading alerts…" messages={['Pulling rules and violations…']} />
              ) : (
                <>
                  <Card>
                    <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Shop/Company Violations ({shopLevelViolations.length})</span></CardHeader>
                    <CardBody>
                      {shopLevelViolations.length === 0 ? (
                        <p className="text-xs font-mono text-inky/60">No shop-level violations as of the last check.</p>
                      ) : (
                        <div className="overflow-x-auto rounded border border-navy/30 max-h-96 overflow-y-auto">
                          <table className="w-full text-xs font-mono">
                            <thead className="sticky top-0 bg-cream">
                              <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                                <th className="px-3 py-2 text-left">Shop</th>
                                <th className="px-3 py-2 text-left">KPI</th>
                                <th className="px-3 py-2 text-left">Period</th>
                                <th className="px-3 py-2 text-right">Actual</th>
                                <th className="px-3 py-2 text-left">Rule</th>
                              </tr>
                            </thead>
                            <tbody>
                              {shopLevelViolations.map((v) => (
                                <tr key={v.id} className="border-b border-navy/10">
                                  <td className="px-3 py-1.5 text-navy whitespace-nowrap">{v.shop_label}</td>
                                  <td className="px-3 py-1.5 text-inky">{KPI_OPTIONS.find((k) => k.value === v.rule_snapshot.kpi)?.label ?? v.rule_snapshot.kpi}</td>
                                  <td className="px-3 py-1.5 text-inky whitespace-nowrap">{v.period_start === v.period_end ? v.period_start : `${v.period_start} to ${v.period_end}`}</td>
                                  <td className="px-3 py-1.5 text-right text-navy tabular-nums">{fmtNum(Number(v.actual_value))}</td>
                                  <td className="px-3 py-1.5 text-inky/60">
                                    {v.rule_snapshot.operator === 'gt' ? `> ${fmtNum(v.rule_snapshot.threshold_low)}` : v.rule_snapshot.operator === 'lt' ? `< ${fmtNum(v.rule_snapshot.threshold_low)}` : `between ${fmtNum(v.rule_snapshot.threshold_low)} and ${fmtNum(v.rule_snapshot.threshold_high)}`}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Employee Violations ({employeeLevelViolations.length})</span></CardHeader>
                    <CardBody>
                      {employeeLevelViolations.length === 0 ? (
                        <p className="text-xs font-mono text-inky/60">No employee-level violations as of the last check.</p>
                      ) : (
                        <div className="overflow-x-auto rounded border border-navy/30 max-h-96 overflow-y-auto">
                          <table className="w-full text-xs font-mono">
                            <thead className="sticky top-0 bg-cream">
                              <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                                <th className="px-3 py-2 text-left">Employee</th>
                                <th className="px-3 py-2 text-left">Shop</th>
                                <th className="px-3 py-2 text-left">KPI</th>
                                <th className="px-3 py-2 text-left">Period</th>
                                <th className="px-3 py-2 text-right">Actual Hours</th>
                                <th className="px-3 py-2 text-left">Rule</th>
                              </tr>
                            </thead>
                            <tbody>
                              {employeeLevelViolations.map((v) => (
                                <tr key={v.id} className="border-b border-navy/10">
                                  <td className="px-3 py-1.5 text-navy whitespace-nowrap">{v.employee_name}</td>
                                  <td className="px-3 py-1.5 text-inky whitespace-nowrap">{v.shop_label}</td>
                                  <td className="px-3 py-1.5 text-inky">{KPI_OPTIONS.find((k) => k.value === v.rule_snapshot.kpi)?.label ?? v.rule_snapshot.kpi}</td>
                                  <td className="px-3 py-1.5 text-inky whitespace-nowrap">{v.period_start === v.period_end ? v.period_start : `${v.period_start} to ${v.period_end}`}</td>
                                  <td className="px-3 py-1.5 text-right text-navy tabular-nums">{fmtNum(Number(v.actual_value))}</td>
                                  <td className="px-3 py-1.5 text-inky/60">
                                    {v.rule_snapshot.operator === 'gt' ? `> ${fmtNum(v.rule_snapshot.threshold_low)}` : v.rule_snapshot.operator === 'lt' ? `< ${fmtNum(v.rule_snapshot.threshold_low)}` : `between ${fmtNum(v.rule_snapshot.threshold_low)} and ${fmtNum(v.rule_snapshot.threshold_high)}`}
                                  </td>
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
          </TabsContent>

          <TabsContent value="manager-labor">
            <div className="flex flex-col gap-4">
              <Card>
                <CardBody className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-xs font-mono text-navy font-bold">
                      Manager hours per day, {managerLaborRange.start} to {managerLaborRange.end}
                    </p>
                    <p className="text-[11px] font-mono text-inky/60 mt-0.5">
                      Fixed trailing 7 full days (not tied to the period picker above) — respects the Region/Market/AM/Shop
                      filters at the top of the page like every other tab.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {cfRules.map((r) => (
                      <span key={r.id} className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: `${r.color}22`, color: r.color }}>
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: r.color }} />
                        {r.operator === 'gt' ? '>' : '<'} {r.threshold}
                      </span>
                    ))}
                    <Button size="sm" variant="secondary" onClick={() => setCfModalOpen(true)}>Conditional Formatting</Button>
                  </div>
                </CardBody>
              </Card>

              {managerLaborError && (
                <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{managerLaborError}</p>
              )}

              {managerLaborLoading ? (
                <LoadingProgress fraction={null} countText="Loading manager labor…" messages={['Pulling the last 7 days of time records…']} />
              ) : managerLaborRows.length === 0 ? (
                <Card><CardBody><p className="text-xs font-mono text-inky/60">No manager clock-ins in the last 7 days for this filter.</p></CardBody></Card>
              ) : (
                <>
                  <Card>
                    <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">All Shops ({managerLaborRows.length})</span></CardHeader>
                    <CardBody>
                      <div className="overflow-auto rounded border border-navy/20 max-h-[32rem]">
                        <table className="w-full text-xs font-mono">
                          <thead className="sticky top-0 bg-cream">
                            <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                              <th className="px-3 py-2 text-left">Shop</th>
                              {managerLaborRange.days.map((d) => <th key={d} className="px-3 py-2 text-right">{dayColumnLabel(d)}</th>)}
                              <th className="px-3 py-2 text-right">Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {managerLaborRows.map((r, i) => {
                              const total = managerLaborRange.days.reduce((sum, d) => sum + (r.hoursByDay[d] ?? 0), 0)
                              return (
                                <tr key={r.locationId} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                                  <td className="px-3 py-1.5 text-navy whitespace-nowrap">{r.shopLabel}</td>
                                  {managerLaborRange.days.map((d) => (
                                    <td key={d} className="px-3 py-1.5 text-right text-navy" style={cfCellStyle(r.hoursByDay[d] ?? 0)}>
                                      {fmtNum(r.hoursByDay[d] ?? 0, 1)}
                                    </td>
                                  ))}
                                  <td className="px-3 py-1.5 text-right text-navy font-bold">{fmtNum(total, 1)}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader>
                      <span className="text-xs font-mono text-navy uppercase tracking-wide">
                        Flagged Shops ({flaggedManagerLaborRows.length})
                      </span>
                    </CardHeader>
                    <CardBody>
                      {cfRules.length === 0 ? (
                        <p className="text-xs font-mono text-inky/60">No conditional formatting rules set — add one above to flag shops here.</p>
                      ) : flaggedManagerLaborRows.length === 0 ? (
                        <p className="text-xs font-mono text-[#2ECC71]">No shops match any rule in this range/filter.</p>
                      ) : (
                        <div className="overflow-auto rounded border border-navy/20 max-h-[32rem]">
                          <table className="w-full text-xs font-mono">
                            <thead className="sticky top-0 bg-cream">
                              <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                                <th className="px-3 py-2 text-left">Shop</th>
                                {managerLaborRange.days.map((d) => <th key={d} className="px-3 py-2 text-right">{dayColumnLabel(d)}</th>)}
                                <th className="px-3 py-2 text-right">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {flaggedManagerLaborRows.map((r, i) => {
                                const total = managerLaborRange.days.reduce((sum, d) => sum + (r.hoursByDay[d] ?? 0), 0)
                                return (
                                  <tr key={r.locationId} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{r.shopLabel}</td>
                                    {managerLaborRange.days.map((d) => (
                                      <td key={d} className="px-3 py-1.5 text-right text-navy" style={cfCellStyle(r.hoursByDay[d] ?? 0)}>
                                        {fmtNum(r.hoursByDay[d] ?? 0, 1)}
                                      </td>
                                    ))}
                                    <td className="px-3 py-1.5 text-right text-navy font-bold">{fmtNum(total, 1)}</td>
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
            </div>
          </TabsContent>

          {/* Labor Config — hosts the Staffing List roster (real
              employee -> Manager/Hourly, takes priority over the wage
              threshold below), the wage-threshold proxy itself (fallback
              for anyone not on the roster), and the Labor Hour Forecast
              upload. */}
          <TabsContent value="labor-config">
            <div className="flex flex-col gap-4">
              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Day of Week KPIs</span></CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <p className="text-[11px] font-mono text-inky/60">
                    Which KPI cards show on the Summary tab's By Day of Week section — applies for everyone, company-wide.
                    The M5 cards need a single shop selected in the filter bar above to show real numbers (the manager
                    present/off split is inherently shop-specific).
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {DOW_KPI_OPTIONS.map((opt) => (
                      <label key={opt.key} className="flex items-center gap-2 text-xs font-mono text-navy cursor-pointer">
                        <input
                          type="checkbox"
                          checked={dowKpis.includes(opt.key)}
                          onChange={(e) => setDowKpis(e.target.checked ? [...dowKpis, opt.key] : dowKpis.filter((k) => k !== opt.key))}
                          className="accent-navy"
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Staffing List</span></CardHeader>
                <CardBody className="flex flex-col gap-3">
                  <p className="text-[11px] font-mono text-inky/60">
                    Upload a real roster to replace the wage-threshold guess below for anyone on it. Two columns:
                    <strong> Employee</strong> (name, matched against everyone who's ever clocked in — ambiguous or
                    unmatched names are flagged before import) and <strong>Role</strong> (Manager or Hourly). Anyone
                    not on this list still falls back to the wage threshold.
                  </p>
                  <FileUploadZone onParsed={(result) => handleRosterParsed(result)} />
                </CardBody>
              </Card>

              {rosterUploadPreview && (() => {
                const matched = rosterUploadPreview.filter((r) => r.droptopUserId && r.role)
                const unmatched = rosterUploadPreview.filter((r) => !r.droptopUserId || !r.role)
                const PREVIEW_LIMIT = 30
                return (
                  <Card>
                    <CardHeader>
                      <span className="text-xs font-mono text-navy uppercase tracking-wide">
                        Review Staffing List Import — {matched.length} row(s) ready{unmatched.length ? `, ${unmatched.length} skipped` : ''}
                      </span>
                    </CardHeader>
                    <CardBody className="flex flex-col gap-3">
                      <div className="overflow-auto rounded border border-navy/30 max-h-72">
                        <table className="w-full text-xs font-mono">
                          <thead className="sticky top-0 bg-cream">
                            <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                              <th className="px-2 py-1.5 text-left">Employee (as uploaded)</th>
                              <th className="px-2 py-1.5 text-left">Matched Employee</th>
                              <th className="px-2 py-1.5 text-left">Role</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rosterUploadPreview.slice(0, PREVIEW_LIMIT).map((r, i) => (
                              <tr key={i} className={[i % 2 ? 'bg-navy/[0.02]' : '', !r.droptopUserId || !r.role ? 'text-[#C0392B]' : ''].join(' ')}>
                                <td className="px-2 py-1">{r.nameRaw}</td>
                                <td className="px-2 py-1">
                                  {r.ambiguous ? `Ambiguous (${r.ambiguous} matches)` : r.droptopUserId ? r.matchedName : 'No match'}
                                </td>
                                <td className="px-2 py-1">{r.role ?? 'Unrecognized'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {rosterUploadPreview.length > PREVIEW_LIMIT && (
                        <p className="text-[11px] font-mono text-inky/60">Showing first {PREVIEW_LIMIT} of {rosterUploadPreview.length} rows.</p>
                      )}
                      <div className="flex items-center gap-2">
                        <Button size="sm" loading={importingRoster} disabled={!matched.length} onClick={confirmRosterImport}>
                          Confirm Import ({matched.length})
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setRosterUploadPreview(null)}>Cancel</Button>
                      </div>
                    </CardBody>
                  </Card>
                )
              })()}

              <Card>
                <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Manager Wage Threshold</span></CardHeader>
                <CardBody className="flex flex-col gap-2">
                  <p className="text-[11px] font-mono text-inky/60">
                    Droptop's time clock has no role/title field, so there's no direct way to tell a shop manager
                    apart from an hourly employee. This is the fallback for anyone not on the Staffing List above:
                    anyone clocked in at or above this hourly wage counts as a manager for the Actual-vs-Forecast
                    split below. Adjust it to match your actual pay bands — it applies company-wide.
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
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Format</span>
                    <Button size="sm" variant={forecastUploadMode === 'tall' ? 'primary' : 'secondary'}
                      onClick={() => setForecastUploadMode('tall')}>Tall (one row per date)</Button>
                    <Button size="sm" variant={forecastUploadMode === 'wide' ? 'primary' : 'secondary'}
                      onClick={() => setForecastUploadMode('wide')}>Wide (dates across columns)</Button>
                  </div>
                  {forecastUploadMode === 'tall' ? (
                    <p className="text-[11px] font-mono text-inky/60">
                      One row per shop per date. Expected columns (header names are matched loosely, case-insensitive):
                      <strong> Shop</strong> (number or name), <strong>Date</strong>, <strong>Hourly Hours</strong> and/or
                      <strong> Manager Hours</strong> (at least one required). Re-uploading the same shop/date updates
                      that row rather than duplicating it.
                    </p>
                  ) : (
                    <p className="text-[11px] font-mono text-inky/60">
                      One row per shop; every column after <strong>Shop</strong> is itself a date (e.g. <strong>9/14/2026</strong>),
                      and each cell is that shop's forecast hours for that day. A blank cell is skipped (no forecast for
                      that day), not treated as zero. Wide uploads carry a single hours value per shop/date — no hourly
                      vs. manager split — use Tall format instead if you need that split.
                    </p>
                  )}
                  <FileUploadZone onParsed={(result) => (forecastUploadMode === 'wide' ? handleWideParsed(result) : handleParsed(result))} />
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

      <Modal open={cfModalOpen} onClose={() => setCfModalOpen(false)} title="Conditional Formatting — Manager Labor" size="md">
        <div className="flex flex-col gap-4">
          <p className="text-[11px] font-mono text-inky/60">
            Add as many rules as you want — every cell on the Manager Labor tab is checked against each rule in order,
            and the first one that matches sets that cell's highlight color.
          </p>
          {cfRules.length > 0 && (
            <div className="flex flex-col gap-2">
              {cfRules.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 border-b border-navy/10 pb-2 last:border-0 last:pb-0">
                  <div className="flex items-center gap-2 text-xs font-mono text-navy">
                    <span className="inline-block w-3 h-3 rounded-full border border-navy/20" style={{ background: r.color }} />
                    Hours {r.operator === 'gt' ? 'greater than' : 'less than'} {r.threshold}
                  </div>
                  <button onClick={() => removeCfRule(r.id)} className="text-[11px] font-mono text-[#C0392B] hover:underline">Remove</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 flex-wrap border-t border-navy/10 pt-3">
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Condition</span>
              <select value={newCfOperator} onChange={(e) => setNewCfOperator(e.target.value as 'gt' | 'lt')} className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy">
                <option value="lt">Less than</option>
                <option value="gt">Greater than</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Hours</span>
              <Input type="number" value={newCfThreshold} onChange={(e) => setNewCfThreshold(e.target.value)} className="w-24" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Color</span>
              <input type="color" value={newCfColor} onChange={(e) => setNewCfColor(e.target.value)} className="w-12 h-9 rounded border border-navy/30 bg-cream cursor-pointer" />
            </label>
            <Button size="sm" onClick={addCfRule}>Add Rule</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
