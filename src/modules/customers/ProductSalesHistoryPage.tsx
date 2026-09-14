// Product Sales History — sales by shop by period for one or more
// products, combining order data with usage data.
//
// "Order data" here means inventory.droptop_order_services' own nested
// `products` jsonb array (confirmed 1.68M+ real rows), NOT the flat
// inventory.droptop_order_products table, which stays genuinely empty for
// this account — same distinction Droptop Orders' own Products column and
// product-id filter already had to make (see that file's own header
// comment: "most consumed products ... only ever show up inside services,
// not the flat top-level array"). Fetched server-side via
// get_droptop_order_product_sales (join + jsonb unnest + date filter,
// migration 20260930l) rather than pulled client-side, given how large
// droptop_order_services is. Confirmed real product_id overlap with the
// usage ledger too (~1,527 of ~1,618-1,730 distinct ids on each side), so
// the two sources genuinely combine into one coherent picture rather than
// being disconnected id spaces — usage data (inventory.daily_product_
// activity, the real day-by-day ledger, NOT product_usage which only
// stores a rolling rate with no per-day history) is the other source,
// merged in below.
//
// Not one of the 5 shapes in TABLE_TEMPLATES.md (a shop-expands-to-periods
// hierarchy, wide multi-product columns, plus a separate compare mode) —
// hand-rolled with its own CSV export, same precedent as Staffing Report's
// RollupTable.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { Card, CardHeader, CardBody, MultiSelectDropdown, Button, SbLoader } from '@/components/ui'

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

export function ProductSalesHistoryPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations('other')
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } =
    useDateRangePeriod('product-sales-history:period', 'last_month')
  const [granularity, setGranularity] = useState<Granularity>('week')

  // ---- Filters (Region/Market/AM/Shop — same shape as Droptop Orders/Staffing Report) ----
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
  }, [companyId, selectedProducts, range.start, range.end])

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

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Product Sales History</h1>
        <p className="text-xs text-inky mt-0.5">
          Sales by shop by period, combining order data (each order's own package/service line items) with the daily
          usage ledger. Pick one or more products below to load data — the table gets a wider column pair for each
          one, matching the CSV export.
        </p>
      </div>

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
