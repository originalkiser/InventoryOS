// Product Sales History — two tabs:
//
// "Monthly Summary" (default) reads from the precomputed
// inventory.product_sales_monthly rollup (migration 20260930bw) instead of
// the live join below, which is why it can afford to be the company-wide
// landing view: shop x product x category x month, refreshed one month at
// a time via refresh_product_sales_monthly (SECURITY INVOKER, its own
// elevated statement_timeout — confirmed via EXPLAIN ANALYZE against
// production that one month's worth of the live join genuinely costs
// ~30s regardless of join strategy, real data volume, not a fixable index
// gap). Drills company-wide -> by simple_category -> by shop -> by
// product (or "base part" rollup, collapsing case-type suffixes via
// baseProductId, to spot an odd trim/case-type driving a shop's number).
// Shows every month in the selected range as its own column rather than
// collapsing the range into one total, unlike the Detail tab below.
//
// "Detail" is the original per-product day/week/month view, unchanged
// EXCEPT: Group By = Month now also reads from product_sales_monthly
// (same bucket keys, 'YYYY-MM') instead of re-running the live join —
// directly fixes the "canceling statement due to statement timeout" case
// this page kept hitting (multiple products x a multi-month range). Day
// and Week grouping still need day-grain data no monthly rollup can
// provide, so they stay on the original live path.
//
// "Order data" here means inventory.droptop_order_services' own nested
// `products` jsonb array (confirmed 1.68M+ real rows), NOT the flat
// inventory.droptop_order_products table, which stays genuinely empty for
// this account — same distinction Droptop Orders' own Products column and
// product-id filter already had to make (see that file's own header
// comment: "most consumed products ... only ever show up inside services,
// not the flat top-level array"). Confirmed real product_id overlap with
// the usage ledger too (~1,527 of ~1,618-1,730 distinct ids on each side),
// so the two sources genuinely combine into one coherent picture rather
// than being disconnected id spaces — usage data (inventory.daily_product_
// activity, the real day-by-day ledger, NOT product_usage which only
// stores a rolling rate with no per-day history) is the other source.
//
// Not one of the 5 shapes in TABLE_TEMPLATES.md — hand-rolled with its own
// CSV export, same precedent as Staffing Report's RollupTable.
import { useEffect, useMemo, useState } from 'react'
import { format, subMonths } from 'date-fns'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { baseProductId } from '@/lib/productFamily'
import { Card, CardHeader, CardBody, MultiSelectDropdown, Button, SbLoader, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'

const PAGE = 1000
async function fetchAllPages<T>(
  build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  onPage?: (rowsSoFar: number) => void,
): Promise<T[]> {
  const all: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await build(from)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    all.push(...batch)
    onPage?.(all.length)
    // Exit only on a genuinely empty page — `batch.length < PAGE` is NOT a
    // safe stopping condition (found live 2026-09-28, PoStatusPage.tsx): if
    // the server's own Max Rows cap ever comes in below PAGE, this would
    // stop after the very first page every time, silently truncating the
    // whole result set.
    if (batch.length === 0) break
    from += batch.length
  }
  return all
}

function fmtNum(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—'
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

type Granularity = 'day' | 'week' | 'month'

// Sunday-start weeks, matching this app's convention everywhere else
// (Staffing Report, WEEKDAY_ORDER, etc.).
function bucketKeyFor(dateStr: string, granularity: Granularity): string {
  if (granularity === 'day') return dateStr
  if (granularity === 'month') return dateStr.slice(0, 7)
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay())
  return d.toISOString().slice(0, 10)
}
// Every distinct bucket the selected range actually spans, regardless of
// whether a given bucket has any sales data — this is what lets "average
// per day/week/month" divide by the TRUE number of periods observed, not
// just the periods that happened to have a sale.
function enumeratePeriods(start: string, end: string, granularity: Granularity): string[] {
  const keys = new Set<string>()
  const endD = new Date(`${end}T00:00:00Z`)
  for (let d = new Date(`${start}T00:00:00Z`); d <= endD; d = new Date(d.getTime() + 86400_000)) {
    keys.add(bucketKeyFor(d.toISOString().slice(0, 10), granularity))
  }
  return [...keys].sort()
}
function periodLabel(key: string, granularity: Granularity): string {
  if (granularity === 'month') {
    const [y, m] = key.split('-')
    return `${m}/${y}`
  }
  if (granularity === 'day') {
    const [, m, d] = key.split('-')
    return `${m}/${d}`
  }
  const start = new Date(`${key}T00:00:00Z`)
  const end = new Date(start.getTime() + 6 * 86400_000)
  const fmt = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
  return `${fmt(start)}–${fmt(end)}`
}

interface UsageRow { location_id: string | null; product_id: string; activity_date: string; sold_qty: string | number | null }
interface ProductOption { productId: string; totalSold: number; rowCount: number }

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ---- Monthly Summary tab helpers ----
const SIMPLE_CATEGORIES = ['Oil', 'Parts', 'Additives', 'Other'] as const
type SimpleCat = typeof SIMPLE_CATEGORIES[number]
// Same "unmapped/unrecognized -> Other" convention get_current_balance_by_
// category already uses (FILTER (WHERE cs.simple_category IS NULL OR ...
// NOT IN ('Oil','Parts','Additives'))) — simple_category is stored as
// whatever category_simplification says (possibly null/unmapped), and it's
// the READER's job to bucket that into "Other", not the writer's.
function bucketOf(sc: string | null): SimpleCat {
  return sc === 'Oil' || sc === 'Parts' || sc === 'Additives' ? sc : 'Other'
}
const CATEGORY_COLORS: Record<SimpleCat, string> = { Oil: '#B7E0DE', Parts: '#4F7489', Additives: '#2ECC71', Other: '#E67E22' }

function monthKeyOf(dateStr: string): string { return dateStr.slice(0, 7) }
function monthLabel(key: string): string { const [y, m] = key.split('-'); return `${m}/${y.slice(2)}` }
function monthDateOf(key: string): string { return `${key}-01` }
function thisMonthKey(): string { return format(new Date(), 'yyyy-MM') }
function monthsAgoKey(n: number): string { return format(subMonths(new Date(), n), 'yyyy-MM') }
function enumerateMonths(fromKey: string, toKey: string): string[] {
  const out: string[] = []
  let [y, m] = fromKey.split('-').map(Number)
  const [ey, em] = toKey.split('-').map(Number)
  let guard = 0
  while ((y < ey || (y === ey && m <= em)) && guard++ < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++; if (m > 12) { m = 1; y++ }
  }
  return out
}

interface PivotRow { key: string; label: string; monthly: Map<string, number> }
function rowTotal(r: PivotRow): number { return [...r.monthly.values()].reduce((a, b) => a + b, 0) }

function exportPivotCsv(filename: string, rows: PivotRow[], months: string[]) {
  const header = ['Label', ...months.map(monthLabel), 'Total']
  const body = rows.map((r) => [r.label, ...months.map((mk) => String(r.monthly.get(mk) ?? 0)), String(rowTotal(r))])
  downloadCsv(filename, [header, ...body])
}

function PivotTable({ rows, months, onRowClick, labelHeader = 'Label', totalLabel = 'Total' }: {
  rows: PivotRow[]
  months: string[]
  onRowClick?: (key: string) => void
  labelHeader?: string
  totalLabel?: string
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => rowTotal(b) - rowTotal(a)), [rows])
  const monthTotals = useMemo(() => months.map((mk) => sorted.reduce((s, r) => s + (r.monthly.get(mk) ?? 0), 0)), [months, sorted])
  const grandTotal = monthTotals.reduce((a, b) => a + b, 0)
  if (sorted.length === 0) return <p className="text-xs font-mono text-inky/60">No sales for this selection.</p>
  return (
    <div className="overflow-auto rounded border border-navy/20 max-h-[32rem]">
      <table className="w-full text-xs font-mono">
        <thead className="sticky top-0 bg-cream">
          <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
            <th className="px-3 py-2 text-left">{labelHeader}</th>
            {months.map((mk) => <th key={mk} className="px-2 py-2 text-right whitespace-nowrap">{monthLabel(mk)}</th>)}
            <th className="px-2 py-2 text-right font-bold border-l border-navy/10">Total</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.key} className={[i % 2 ? 'bg-navy/[0.02]' : '', onRowClick ? 'cursor-pointer hover:bg-sky/10' : ''].join(' ')}
              onClick={() => onRowClick?.(r.key)}>
              <td className={`px-3 py-1.5 text-navy whitespace-nowrap ${onRowClick ? 'underline decoration-dotted' : ''}`}>{r.label}</td>
              {months.map((mk) => <td key={mk} className="px-2 py-1.5 text-right text-navy">{fmtNum(r.monthly.get(mk) ?? 0, 0)}</td>)}
              <td className="px-2 py-1.5 text-right font-bold text-navy border-l border-navy/10">{fmtNum(rowTotal(r), 0)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-navy/30 font-bold">
            <td className="px-3 py-1.5 text-navy">{totalLabel}</td>
            {monthTotals.map((v, i) => <td key={months[i]} className="px-2 py-1.5 text-right text-navy">{fmtNum(v, 0)}</td>)}
            <td className="px-2 py-1.5 text-right text-navy border-l border-navy/10">{fmtNum(grandTotal, 0)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

interface ShopCategoryRow { location_id: string | null; simple_category: string | null; sale_month: string; qty: number | string }

function MonthlySummaryTab({ companyId, allowedLocationIds, loc }: {
  companyId: string
  allowedLocationIds: Set<string> | null
  loc: ReturnType<typeof useLocations>
}) {
  const [fromMonth, setFromMonth] = useState(() => monthsAgoKey(5))
  const [toMonth, setToMonth] = useState(() => thisMonthKey())
  const months = useMemo(() => enumerateMonths(fromMonth, toMonth), [fromMonth, toMonth])

  // ---- Level 0/1 data: (shop, simple_category, month) -> qty. Small
  // regardless of range (shops x 4 categories x months), so this stays a
  // single fast fetch that supports arbitrary client-side shop filtering
  // and drilling from company-wide -> category -> shop without another
  // round trip. ----
  const [shopCategoryRows, setShopCategoryRows] = useState<ShopCategoryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true); setError(null)
    const sb = supabase as any
    sb.rpc('get_product_sales_monthly_by_shop_category', { p_start: monthDateOf(fromMonth), p_end: monthDateOf(toMonth) })
      .then(({ data, error: err }: any) => {
        if (cancelled) return
        if (err) { setError(err.message); setLoading(false); return }
        setShopCategoryRows((data ?? []) as ShopCategoryRow[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [companyId, fromMonth, toMonth])

  const filteredShopCategoryRows = useMemo(
    () => shopCategoryRows.filter((r) => r.location_id && (!allowedLocationIds || allowedLocationIds.has(r.location_id))),
    [shopCategoryRows, allowedLocationIds],
  )

  const [selectedCategory, setSelectedCategory] = useState<SimpleCat | null>(null)
  const [selectedShopId, setSelectedShopId] = useState<string | null>(null)
  const [rollupMode, setRollupMode] = useState<'product' | 'base'>('product')

  const categoryRows = useMemo((): PivotRow[] => {
    const m = new Map<SimpleCat, Map<string, number>>()
    for (const r of filteredShopCategoryRows) {
      const cat = bucketOf(r.simple_category)
      const mk = monthKeyOf(r.sale_month)
      const byMonth = m.get(cat) ?? new Map<string, number>()
      byMonth.set(mk, (byMonth.get(mk) ?? 0) + (Number(r.qty) || 0))
      m.set(cat, byMonth)
    }
    return SIMPLE_CATEGORIES.map((c) => ({ key: c, label: c, monthly: m.get(c) ?? new Map() }))
  }, [filteredShopCategoryRows])

  const chartData = useMemo(
    () => months.map((mk) => {
      const row: Record<string, number | string> = { month: monthLabel(mk) }
      for (const c of categoryRows) row[c.label] = c.monthly.get(mk) ?? 0
      return row
    }),
    [months, categoryRows],
  )

  const shopRowsForCategory = useMemo((): PivotRow[] => {
    if (!selectedCategory) return []
    const m = new Map<string, Map<string, number>>()
    for (const r of filteredShopCategoryRows) {
      if (bucketOf(r.simple_category) !== selectedCategory || !r.location_id) continue
      const mk = monthKeyOf(r.sale_month)
      const byMonth = m.get(r.location_id) ?? new Map<string, number>()
      byMonth.set(mk, (byMonth.get(mk) ?? 0) + (Number(r.qty) || 0))
      m.set(r.location_id, byMonth)
    }
    return [...m.entries()].map(([id, monthly]) => ({ key: id, label: loc.labelOf(id), monthly }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredShopCategoryRows, selectedCategory, loc.labelOf])

  // ---- Level 2 data: full product detail for ONE shop only, fetched
  // directly (not through the small shop/category RPC above) — a single
  // shop's own rows for the whole range are tiny regardless of company
  // size, so this doesn't need its own aggregating RPC.
  const [shopProductRows, setShopProductRows] = useState<{ product_id: string; sale_month: string; category: string | null; simple_category: string | null; qty_sold: number | string }[]>([])
  const [productLoading, setProductLoading] = useState(false)
  const [productError, setProductError] = useState<string | null>(null)
  useEffect(() => {
    if (!companyId || !selectedShopId) { setShopProductRows([]); return }
    let cancelled = false
    setProductLoading(true); setProductError(null)
    const sb = supabase as any
    fetchAllPages<{ product_id: string; sale_month: string; category: string | null; simple_category: string | null; qty_sold: number | string }>((from) =>
      sb.schema('inventory').from('product_sales_monthly')
        .select('product_id, sale_month, category, simple_category, qty_sold')
        .eq('company_id', companyId).eq('location_id', selectedShopId)
        .gte('sale_month', monthDateOf(fromMonth)).lte('sale_month', monthDateOf(toMonth))
        .range(from, from + PAGE - 1))
      .then((rows) => { if (!cancelled) { setShopProductRows(rows); setProductLoading(false) } })
      .catch((e) => { if (!cancelled) { setProductError(e instanceof Error ? e.message : 'Failed to load'); setProductLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, selectedShopId, fromMonth, toMonth])

  const productRowsForShop = useMemo((): PivotRow[] => {
    if (!selectedCategory) return []
    const m = new Map<string, Map<string, number>>()
    for (const r of shopProductRows) {
      if (bucketOf(r.simple_category) !== selectedCategory) continue
      const key = rollupMode === 'base' ? baseProductId(r.product_id) : r.product_id
      const mk = monthKeyOf(r.sale_month)
      const byMonth = m.get(key) ?? new Map<string, number>()
      byMonth.set(mk, (byMonth.get(mk) ?? 0) + (Number(r.qty_sold) || 0))
      m.set(key, byMonth)
    }
    return [...m.entries()].map(([key, monthly]) => ({ key, label: key, monthly }))
  }, [shopProductRows, selectedCategory, rollupMode])

  // ---- Data coverage / rebuild ----
  const [coverage, setCoverage] = useState<Map<string, number>>(new Map())
  const [earliestMonth, setEarliestMonth] = useState<string | null>(null)
  const [rebuildRunning, setRebuildRunning] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState<{ done: number; total: number; label: string } | null>(null)
  const [rebuildError, setRebuildError] = useState<string | null>(null)

  async function loadCoverage() {
    const sb = supabase as any
    const { data } = await sb.rpc('get_product_sales_monthly_coverage')
    setCoverage(new Map(((data ?? []) as { sale_month: string; row_count: number | string }[]).map((r) => [monthKeyOf(r.sale_month), Number(r.row_count) || 0])))
  }
  useEffect(() => {
    if (!companyId) return
    loadCoverage()
    const sb = supabase as any
    sb.schema('inventory').from('droptop_orders').select('order_finalized_at')
      .eq('company_id', companyId).not('order_finalized_at', 'is', null)
      .order('order_finalized_at', { ascending: true }).limit(1)
      .then(({ data }: any) => { if (data?.[0]?.order_finalized_at) setEarliestMonth(monthKeyOf(data[0].order_finalized_at)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId])

  async function refreshMonths(monthKeys: string[]) {
    setRebuildRunning(true); setRebuildError(null)
    const sb = supabase as any
    for (let i = 0; i < monthKeys.length; i++) {
      setRebuildProgress({ done: i, total: monthKeys.length, label: monthLabel(monthKeys[i]) })
      // Each call is its own top-level request — the function's own
      // elevated statement_timeout only takes effect that way (a shared
      // outer transaction/DO-block wrapping several calls does NOT extend
      // to a per-call SET clause, confirmed the hard way seeding this
      // table's initial history).
      const { error: err } = await sb.rpc('refresh_product_sales_monthly', { p_month: monthDateOf(monthKeys[i]) })
      if (err) { setRebuildError(`${monthLabel(monthKeys[i])}: ${err.message}`); setRebuildRunning(false); setRebuildProgress(null); return }
    }
    setRebuildProgress({ done: monthKeys.length, total: monthKeys.length, label: '' })
    await loadCoverage()
    setRebuildRunning(false)
    setTimeout(() => setRebuildProgress(null), 1500)
  }
  function refreshRecent() { refreshMonths([...new Set([monthsAgoKey(1), thisMonthKey()])]) }
  function backfillAll() {
    if (!earliestMonth) return
    const all = enumerateMonths(earliestMonth, thisMonthKey())
    if (!confirm(`This refreshes ${all.length} month(s) one at a time — each can take up to ~30 seconds (roughly ${Math.ceil(all.length / 2)} minutes total). Continue?`)) return
    refreshMonths(all)
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">From Month</span>
            <input type="month" value={fromMonth} onChange={(e) => e.target.value && setFromMonth(e.target.value)}
              className="border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy bg-cream" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">To Month</span>
            <input type="month" value={toMonth} onChange={(e) => e.target.value && setToMonth(e.target.value)}
              className="border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy bg-cream" />
          </label>
          <div className="flex-1" />
          {earliestMonth && (
            <div className="flex flex-col gap-1 items-end">
              <div className="flex gap-1 flex-wrap max-w-md justify-end">
                {enumerateMonths(earliestMonth, thisMonthKey()).map((mk) => (
                  <span key={mk} title={coverage.has(mk) ? `${coverage.get(mk)!.toLocaleString()} rows built` : 'Not built yet'}
                    className={['px-1.5 py-0.5 rounded text-[10px] font-mono border',
                      coverage.has(mk) ? 'bg-sb-green/15 border-sb-green/40 text-navy' : 'bg-transparent border-navy/20 text-inky/40'].join(' ')}>
                    {monthLabel(mk)}
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={rebuildRunning} onClick={refreshRecent}>Refresh Recent</Button>
                <Button size="sm" variant="secondary" disabled={rebuildRunning} onClick={backfillAll}>Backfill Full History</Button>
              </div>
            </div>
          )}
        </CardBody>
        {rebuildProgress && (
          <CardBody className="pt-0">
            <LoadingProgress fraction={rebuildProgress.total ? rebuildProgress.done / rebuildProgress.total : null}
              countText={`Refreshing ${rebuildProgress.label || 'done'} — ${rebuildProgress.done} of ${rebuildProgress.total}`}
              messages={['Recomputing shop x product totals…']} />
          </CardBody>
        )}
        {rebuildError && <CardBody className="pt-0"><p className="text-xs font-mono text-[#C0392B]">{rebuildError}</p></CardBody>}
      </Card>

      {error && <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>}

      {loading ? (
        <div className="py-10 flex justify-center"><SbLoader size={32} /></div>
      ) : selectedShopId ? (
        <Card>
          <CardHeader className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">
              Product Detail — {loc.labelOf(selectedShopId)} · {selectedCategory}
            </span>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[11px] font-mono">
                {(['product', 'base'] as const).map((m) => (
                  <button key={m} onClick={() => setRollupMode(m)}
                    className={['px-2.5 py-1 uppercase tracking-wide transition-colors', rollupMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                    {m === 'product' ? 'Product ID' : 'Base Part'}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="secondary" onClick={() => exportPivotCsv(`product-sales-${loc.labelOf(selectedShopId)}-${selectedCategory}.csv`, productRowsForShop, months)}>Export CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => setSelectedShopId(null)}>← Back to Shops</Button>
            </div>
          </CardHeader>
          <CardBody>
            {rollupMode === 'base' && (
              <p className="text-[10px] font-mono text-inky/50 mb-2">
                Base Part sums every case-type variant of a product together (e.g. a drum and a bulk tote of the same
                oil) — switch to Product ID to see whether one specific variant is driving the number.
              </p>
            )}
            {productLoading ? <div className="py-6 flex justify-center"><SbLoader size={24} /></div>
              : productError ? <p className="text-xs font-mono text-[#C0392B]">{productError}</p>
              : <PivotTable rows={productRowsForShop} months={months} labelHeader={rollupMode === 'base' ? 'Base Part' : 'Product ID'} />}
          </CardBody>
        </Card>
      ) : selectedCategory ? (
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">By Shop — {selectedCategory} ({shopRowsForCategory.length})</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => exportPivotCsv(`product-sales-${selectedCategory}-by-shop.csv`, shopRowsForCategory, months)}>Export CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => setSelectedCategory(null)}>← Back to Categories</Button>
            </div>
          </CardHeader>
          <CardBody><PivotTable rows={shopRowsForCategory} months={months} labelHeader="Shop" onRowClick={setSelectedShopId} /></CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Company-Wide, by Category</span></CardHeader>
            <CardBody>
              <div className="rounded-lg bg-sb-navy px-4 py-4">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: '#F2F1E6', fontSize: 10, fontFamily: '"DM Mono", monospace' }} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
                    <YAxis tick={{ fill: '#F2F1E6', fontSize: 10, fontFamily: '"DM Mono", monospace' }} axisLine={false} tickLine={false} width={60} />
                    <Tooltip contentStyle={{ background: '#002745', border: '1px solid rgba(183,224,222,0.3)', borderRadius: 4, fontFamily: '"DM Mono", monospace', fontSize: 11, color: '#F2F1E6' }} />
                    <Legend wrapperStyle={{ fontFamily: '"DM Mono", monospace', fontSize: 11, color: '#F2F1E6' }} />
                    {SIMPLE_CATEGORIES.map((c) => <Bar key={c} dataKey={c} stackId="a" fill={CATEGORY_COLORS[c]} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader className="flex items-center justify-between">
              <span className="text-xs font-mono text-navy uppercase tracking-wide">By Category</span>
              <Button size="sm" variant="secondary" onClick={() => exportPivotCsv('product-sales-by-category.csv', categoryRows, months)}>Export CSV</Button>
            </CardHeader>
            <CardBody><PivotTable rows={categoryRows} months={months} labelHeader="Category" onRowClick={(k) => setSelectedCategory(k as SimpleCat)} /></CardBody>
          </Card>
        </>
      )}
    </div>
  )
}

// ---- Detail tab (original per-product day/week/month view) ----
function DetailTab({ companyId, allowedLocationIds, loc, regionOptions, marketOptions, amOptions, filterRegions, setFilterRegions, filterMarkets, setFilterMarkets, filterAMs, setFilterAMs, shopOptions, shopLabels, setShopLabels, labelToId }: {
  companyId: string
  allowedLocationIds: Set<string> | null
  loc: ReturnType<typeof useLocations>
  regionOptions: { value: string }[]
  marketOptions: { value: string }[]
  amOptions: { value: string }[]
  filterRegions: string[]; setFilterRegions: (v: string[]) => void
  filterMarkets: string[]; setFilterMarkets: (v: string[]) => void
  filterAMs: string[]; setFilterAMs: (v: string[]) => void
  shopOptions: { value: string }[]
  shopLabels: string[]; setShopLabels: (v: string[]) => void
  labelToId: Map<string, string>
}) {
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } =
    useDateRangePeriod('product-sales-history:period', 'last_month')
  const [granularity, setGranularity] = useState<Granularity>('week')

  // ---- Product picker ----
  const [productOptions, setProductOptions] = useState<ProductOption[] | null>(null)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.rpc('get_product_sales_history_product_counts').then(({ data, error }: any) => {
      if (cancelled) return
      if (error) { setProductOptions([]); return }
      setProductOptions(((data ?? []) as { product_id: string; total_sold: number | string; row_count: number | string }[])
        .map((r): ProductOption => ({ productId: r.product_id, totalSold: Number(r.total_sold) || 0, rowCount: Number(r.row_count) || 0 }))
        .sort((a, b) => b.totalSold - a.totalSold))
    })
    return () => { cancelled = true }
  }, [companyId])
  const [selectedProducts, setSelectedProducts] = useState<string[]>([])
  const productMultiOptions = useMemo(
    () => (productOptions ?? []).map((p) => ({ value: p.productId, label: `${p.productId} (${p.totalSold.toLocaleString()} sold)` })),
    [productOptions],
  )

  // ---- Data load — only once at least one product is picked ----
  const [usageRows, setUsageRows] = useState<UsageRow[]>([])
  const [orderProductRows, setOrderProductRows] = useState<UsageRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })

  useEffect(() => {
    if (!companyId || selectedProducts.length === 0) { setUsageRows([]); setOrderProductRows([]); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    setLoadProgress({ loaded: 0, total: null })
    const sb = supabase as any
    async function run() {
      if (granularity === 'month') {
        // Fast path — the precomputed monthly rollup instead of the live
        // join, which is what kept timing out for a wide multi-month range
        // x several products (see this file's own header comment).
        const monthStart = `${range.start.slice(0, 7)}-01`
        const monthEnd = `${range.end.slice(0, 7)}-01`
        const rows = await fetchAllPages<{ location_id: string | null; product_id: string; sale_month: string; qty_sold: number | string }>((from) =>
          sb.schema('inventory').from('product_sales_monthly')
            .select('location_id, product_id, sale_month, qty_sold')
            .eq('company_id', companyId).in('product_id', selectedProducts)
            .gte('sale_month', monthStart).lte('sale_month', monthEnd)
            .range(from, from + PAGE - 1))
        if (cancelled) return
        setUsageRows(rows.map((r) => ({ location_id: r.location_id, product_id: r.product_id, activity_date: r.sale_month, sold_qty: r.qty_sold })))
        setOrderProductRows([])
        setLoading(false)
        return
      }
      const { count } = await sb.schema('inventory').from('daily_product_activity')
        .select('location_id', { count: 'exact', head: true })
        .eq('company_id', companyId).in('product_id', selectedProducts)
        .gte('activity_date', range.start).lte('activity_date', range.end)
      if (cancelled) return
      setLoadProgress({ loaded: 0, total: count ?? null })
      const rows = await fetchAllPages<UsageRow>((from) => sb.schema('inventory').from('daily_product_activity')
        .select('location_id, product_id, activity_date, sold_qty')
        .eq('company_id', companyId).in('product_id', selectedProducts)
        .gte('activity_date', range.start).lte('activity_date', range.end)
        .range(from, from + PAGE - 1), (n) => { if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: n })) })
      if (cancelled) return
      setUsageRows(rows)

      // Server-side join + jsonb unnest (see this file's own header comment
      // for why this can't be a flat droptop_order_products query) —
      // aggregated by the RPC itself, so this is one call, not a paginated
      // per-order fetch.
      const { data: orderData, error: orderErr } = await sb.rpc('get_droptop_order_product_sales', {
        p_start: range.start, p_end: range.end, p_product_ids: selectedProducts,
      })
      if (cancelled) return
      if (orderErr) { setError(orderErr.message); setLoading(false); return }
      setOrderProductRows(((orderData ?? []) as { location_id: string | null; product_id: string; activity_date: string; qty: number | string }[])
        .map((r) => ({ location_id: r.location_id, product_id: r.product_id, activity_date: r.activity_date, sold_qty: r.qty })))
      setLoading(false)
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load sales data'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, selectedProducts, range.start, range.end, granularity])

  const allRows = useMemo(() => [...usageRows, ...orderProductRows], [usageRows, orderProductRows])
  const filteredRows = useMemo(
    () => allRows.filter((r) => r.location_id && (!allowedLocationIds || allowedLocationIds.has(r.location_id))),
    [allRows, allowedLocationIds],
  )

  const periods = useMemo(() => enumeratePeriods(range.start, range.end, granularity), [range.start, range.end, granularity])

  // location_id -> product_id -> period key -> qty
  const byShopProductPeriod = useMemo(() => {
    const m = new Map<string, Map<string, Map<string, number>>>()
    for (const r of filteredRows) {
      if (!r.location_id) continue
      const bucket = bucketKeyFor(r.activity_date, granularity)
      const byProduct = m.get(r.location_id) ?? new Map<string, Map<string, number>>()
      const byPeriod = byProduct.get(r.product_id) ?? new Map<string, number>()
      byPeriod.set(bucket, (byPeriod.get(bucket) ?? 0) + (Number(r.sold_qty) || 0))
      byProduct.set(r.product_id, byPeriod)
      m.set(r.location_id, byProduct)
    }
    return m
  }, [filteredRows, granularity])

  interface ShopSummaryRow { locationId: string; shopLabel: string; totals: Record<string, number>; avgs: Record<string, number> }
  const shopSummaryRows = useMemo((): ShopSummaryRow[] => {
    return [...byShopProductPeriod.entries()].map(([locationId, byProduct]) => {
      const totals: Record<string, number> = {}
      const avgs: Record<string, number> = {}
      for (const p of selectedProducts) {
        const byPeriod = byProduct.get(p)
        const total = byPeriod ? [...byPeriod.values()].reduce((a, b) => a + b, 0) : 0
        totals[p] = total
        avgs[p] = periods.length > 0 ? total / periods.length : 0
      }
      return { locationId, shopLabel: loc.labelOf(locationId), totals, avgs }
    }).sort((a, b) => a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byShopProductPeriod, selectedProducts, periods, loc.labelOf])

  const companyTotals = useMemo(() => {
    const totals: Record<string, number> = {}
    const avgs: Record<string, number> = {}
    for (const p of selectedProducts) {
      const total = shopSummaryRows.reduce((sum, r) => sum + (r.totals[p] ?? 0), 0)
      totals[p] = total
      avgs[p] = periods.length > 0 ? total / periods.length : 0
    }
    return { totals, avgs }
  }, [shopSummaryRows, selectedProducts, periods.length])

  const [expandedShop, setExpandedShop] = useState<string | null>(null)

  // ---- Compare mode ----
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareShops, setCompareShops] = useState<string[]>([])
  const compareShopIds = useMemo(() => compareShops.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [compareShops, labelToId])
  function shopPeriodTotal(locationId: string, periodKey: string): number {
    const byProduct = byShopProductPeriod.get(locationId)
    if (!byProduct) return 0
    let sum = 0
    for (const p of selectedProducts) sum += byProduct.get(p)?.get(periodKey) ?? 0
    return sum
  }
  function shopWholeTotal(locationId: string): number {
    return periods.reduce((sum, p) => sum + shopPeriodTotal(locationId, p), 0)
  }

  function exportCsv() {
    const header = ['Shop', ...selectedProducts.flatMap((p) => [`${p} Total`, `${p} Avg/${granularity}`])]
    const rows = shopSummaryRows.map((r) => [r.shopLabel, ...selectedProducts.flatMap((p) => [String(r.totals[p] ?? 0), fmtNum(r.avgs[p] ?? 0, 2)])])
    downloadCsv(`product-sales-history-${range.start}-to-${range.end}.csv`, [header, ...rows])
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Region</span>
              <MultiSelectDropdown options={regionOptions} selected={filterRegions} onChange={setFilterRegions} placeholder="Any region" countNoun="regions" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Market</span>
              <MultiSelectDropdown options={marketOptions} selected={filterMarkets} onChange={setFilterMarkets} placeholder="Any market" countNoun="markets" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Area Manager</span>
              <MultiSelectDropdown options={amOptions} selected={filterAMs} onChange={setFilterAMs} placeholder="Any AM" countNoun="AMs" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels} placeholder="Any shop" showAllOption={false} searchable countNoun="shops" />
            </div>
          </div>
          <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} onCustomStartChange={setCustomStart} customEnd={customEnd} onCustomEndChange={setCustomEnd} earliestDate={null} />
          <div className="flex items-end gap-4 flex-wrap border-t border-navy/10 pt-3">
            <div className="min-w-[280px]">
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Product(s)</span>
              {productOptions === null ? <div className="py-1"><SbLoader /></div> : (
                <MultiSelectDropdown options={productMultiOptions} selected={selectedProducts} onChange={setSelectedProducts} placeholder="Select product(s)…" showAllOption={false} searchable countNoun="products" />
              )}
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Group By</span>
              <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[11px] font-mono">
                {(['day', 'week', 'month'] as const).map((g) => (
                  <button key={g} onClick={() => setGranularity(g)}
                    className={['px-3 py-1.5 uppercase tracking-wide transition-colors', granularity === g ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                    {g}
                  </button>
                ))}
              </div>
            </label>
            {selectedProducts.length > 0 && (
              <>
                <Button size="sm" variant="secondary" onClick={exportCsv}>Export CSV</Button>
                <Button size="sm" variant="secondary" onClick={() => setCompareOpen((v) => !v)}>{compareOpen ? 'Hide Compare' : 'Compare Shops'}</Button>
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {error && <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>}

      {selectedProducts.length === 0 ? (
        <Card><CardBody><p className="text-xs font-mono text-inky/60">Select at least one product above to load sales history.</p></CardBody></Card>
      ) : loading ? (
        <LoadingProgress
          fraction={loadProgress.total ? loadProgress.loaded / loadProgress.total : null}
          countText={loadProgress.total ? `Loading — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()}` : 'Loading sales history…'}
          messages={['Pulling the daily sales ledger…', 'Matching by shop and period…']}
        />
      ) : (
        <>
          <Card>
            <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Company-Wide</span></CardHeader>
            <CardBody>
              <div className="flex gap-3 flex-wrap">
                {selectedProducts.map((p) => (
                  <div key={p} className="flex-1 min-w-[180px] rounded border border-navy/20 px-3 py-2">
                    <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{p}</p>
                    <p className="text-lg font-heading font-bold text-navy">{fmtNum(companyTotals.totals[p], 0)}</p>
                    <p className="text-[10px] font-mono text-inky/50">avg {fmtNum(companyTotals.avgs[p], 2)}/{granularity}</p>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          {compareOpen && (
            <Card>
              <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Compare Shops</span></CardHeader>
              <CardBody className="flex flex-col gap-3">
                <div className="max-w-md">
                  <MultiSelectDropdown options={shopOptions} selected={compareShops} onChange={setCompareShops} placeholder="Pick 2+ shops to compare" showAllOption={false} searchable countNoun="shops" />
                </div>
                {compareShopIds.length < 2 ? (
                  <p className="text-xs font-mono text-inky/60">Pick at least 2 shops. Values below sum every selected product together.</p>
                ) : (
                  <div className="overflow-auto rounded border border-navy/20 max-h-[28rem]">
                    <table className="w-full text-xs font-mono">
                      <thead className="sticky top-0 bg-cream">
                        <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                          <th className="px-3 py-2 text-left">Period</th>
                          {compareShopIds.map((id) => <th key={id} className="px-3 py-2 text-right">{loc.labelOf(id)}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {periods.map((pKey, i) => (
                          <tr key={pKey} className={i % 2 ? 'bg-navy/[0.02]' : ''}>
                            <td className="px-3 py-1.5 text-navy whitespace-nowrap">{periodLabel(pKey, granularity)}</td>
                            {compareShopIds.map((id) => <td key={id} className="px-3 py-1.5 text-right text-navy">{fmtNum(shopPeriodTotal(id, pKey), 0)}</td>)}
                          </tr>
                        ))}
                        <tr className="border-t-2 border-navy/30 font-bold">
                          <td className="px-3 py-1.5 text-navy">Whole Timeframe</td>
                          {compareShopIds.map((id) => <td key={id} className="px-3 py-1.5 text-right text-navy">{fmtNum(shopWholeTotal(id), 0)}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">By Shop ({shopSummaryRows.length})</span></CardHeader>
            <CardBody>
              {shopSummaryRows.length === 0 ? (
                <p className="text-xs font-mono text-inky/60">No sales for these products/period/filter.</p>
              ) : (
                <div className="overflow-auto rounded border border-navy/20 max-h-[36rem]">
                  <table className="w-full text-xs font-mono">
                    <thead className="sticky top-0 bg-cream">
                      <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                        <th className="px-3 py-2 text-left">Shop</th>
                        {selectedProducts.map((p) => <th key={p} className="px-3 py-1 text-center border-l border-navy/10" colSpan={2}>{p}</th>)}
                      </tr>
                      <tr className="border-b border-navy/30 text-inky/60">
                        <th />
                        {selectedProducts.map((p) => (
                          <>
                            <th key={`${p}-total`} className="px-2 py-1 text-right border-l border-navy/10 font-normal">Total</th>
                            <th key={`${p}-avg`} className="px-2 py-1 text-right font-normal">Avg/{granularity}</th>
                          </>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {shopSummaryRows.map((r, i) => {
                        const isOpen = expandedShop === r.locationId
                        const byProduct = byShopProductPeriod.get(r.locationId)
                        return (
                          <>
                            <tr key={r.locationId} className={`cursor-pointer hover:bg-sky/10 ${i % 2 ? 'bg-navy/[0.02]' : ''}`}
                              onClick={() => setExpandedShop(isOpen ? null : r.locationId)}>
                              <td className="px-3 py-1.5 text-navy whitespace-nowrap underline decoration-dotted">
                                <span className={`inline-block mr-1 transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>{r.shopLabel}
                              </td>
                              {selectedProducts.map((p) => (
                                <>
                                  <td key={`${p}-total`} className="px-2 py-1.5 text-right text-navy border-l border-navy/10">{fmtNum(r.totals[p] ?? 0, 0)}</td>
                                  <td key={`${p}-avg`} className="px-2 py-1.5 text-right text-navy/70">{fmtNum(r.avgs[p] ?? 0, 2)}</td>
                                </>
                              ))}
                            </tr>
                            {isOpen && periods.map((pKey) => (
                              <tr key={`${r.locationId}-${pKey}`} className="bg-sky/5">
                                <td className="px-3 py-1 text-inky/70 pl-8 whitespace-nowrap">{periodLabel(pKey, granularity)}</td>
                                {selectedProducts.map((p) => (
                                  <td key={p} className="px-2 py-1 text-right text-inky/70 border-l border-navy/10" colSpan={2}>
                                    {fmtNum(byProduct?.get(p)?.get(pKey) ?? 0, 0)}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </>
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
  )
}

export function ProductSalesHistoryPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations('other')

  // ---- Filters (Region/Market/AM/Shop) shared by both tabs ----
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [shopLabels, setShopLabels] = useState<string[]>([])
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

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Product Sales History</h1>
        <p className="text-xs text-inky mt-0.5">
          Monthly Summary reads a precomputed rollup and can afford to be company-wide by default; Detail lets you
          inspect specific products day-by-day or week-by-week.
        </p>
      </div>

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">Monthly Summary</TabsTrigger>
          <TabsTrigger value="detail">Detail</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <MonthlySummaryTab companyId={companyId} allowedLocationIds={allowedLocationIds} loc={loc} />
        </TabsContent>
        <TabsContent value="detail">
          <DetailTab
            companyId={companyId} allowedLocationIds={allowedLocationIds} loc={loc}
            regionOptions={regionOptions} marketOptions={marketOptions} amOptions={amOptions}
            filterRegions={filterRegions} setFilterRegions={setFilterRegions}
            filterMarkets={filterMarkets} setFilterMarkets={setFilterMarkets}
            filterAMs={filterAMs} setFilterAMs={setFilterAMs}
            shopOptions={shopOptions} shopLabels={shopLabels} setShopLabels={setShopLabels}
            labelToId={labelToId}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
